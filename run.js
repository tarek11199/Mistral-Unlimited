const puppeteer = require("puppeteer");
const fs = require("fs");

const TARGET_URL = "https://v2.auth.mistral.ai/login";

// EduMails temporary student-email API.
const API_BASE = "https://api.edu-mails.com/api";

// ---- helpers -------------------------------------------------------------

// Random integer in [min, max] (inclusive) - used for human-like waits.
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// Promise-based sleep.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Artificial "human" pause with a randomized duration.
const humanPause = (min = 400, max = 1200) => sleep(rand(min, max));

// The email field has a dynamic id, so we match on stable attributes instead.
const EMAIL_SELECTOR =
	'input[name="email"], input[inputmode="email"], input[autocomplete="username"]';

// Password to use on signup.
const PASSWORD = "Zahid456@@5";

// Random person-name pools for the first/last name fields.
const FIRST_NAMES = [
	"James", "Olivia", "Liam", "Emma", "Noah", "Ava", "William", "Sophia",
	"Benjamin", "Isabella", "Lucas", "Mia", "Henry", "Charlotte", "Alexander",
	"Amelia", "Daniel", "Harper", "Michael", "Evelyn", "Ethan", "Abigail",
];
const LAST_NAMES = [
	"Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller",
	"Davis", "Rodriguez", "Martinez", "Wilson", "Anderson", "Taylor", "Thomas",
	"Moore", "Jackson", "Martin", "Lee", "Thompson", "White", "Harris", "Clark",
];

// Pick a random element from an array.
const pick = (arr) => arr[rand(0, arr.length - 1)];

// Direct input into a field: sets native value, dispatches input/change events directly.
async function directInput(page, selector, text) {
	await page.evaluate((sel, val) => {
		const el = document.querySelector(sel);
		if (el) {
			el.focus();
			const nativeSetter = Object.getOwnPropertyDescriptor(
				window.HTMLInputElement.prototype,
				"value"
			)?.set;
			if (nativeSetter) {
				nativeSetter.call(el, val);
			} else {
				el.value = val;
			}
			el.dispatchEvent(new Event("input", { bubbles: true }));
			el.dispatchEvent(new Event("change", { bubbles: true }));
		}
	}, selector, text);
}

// Fast input wrapper for backwards compatibility
async function humanType(page, selector, text) {
	await directInput(page, selector, text);
}

// Helper to assemble all text content from an API message object.
function getMessageText(m) {
	if (!m) return "";
	if (typeof m === "string") return m;
	const parts = [
		m.subject,
		m.body,
		m.html,
		m.text,
		m.content,
		m.text_body,
		m.html_body,
		m.body_html,
		m.body_text,
		JSON.stringify(m),
	];
	return parts.filter(Boolean).join("\n");
}

// Extract 6-digit OTP code from email messages.
function extractOtp(messages) {
	for (const m of messages) {
		const haystack = getMessageText(m);
		// 1. Try code=XXXXXX (from URL parameters or text)
		const codeParamMatch = haystack.match(/code=(\d{6})/i);
		if (codeParamMatch) return codeParamMatch[1];

		// 2. Try HTML tag 6-digit content e.g. >346601<
		const htmlMatch = haystack.match(/>(\d{6})</);
		if (htmlMatch) return htmlMatch[1];

		// 3. Try standalone 6 digits
		const standaloneMatch = haystack.match(/(?<!\d)\d{6}(?!\d)/);
		if (standaloneMatch) return standaloneMatch[0];
	}
	return null;
}

// Extract direct verification link from email messages.
function extractVerificationLink(messages) {
	for (const m of messages) {
		const haystack = getMessageText(m);
		const match = haystack.match(/https?:\/\/[^\s"'<>]*self-service\/verification[^\s"'<>]+/i);
		if (match) {
			return match[0].replace(/&amp;/g, "&");
		}
	}
	return null;
}

// ---- EduMails API --------------------------------------------------------

// Generate a temporary edu email.
// By default uses a random address. Pass a custom alias + domainId to request
// a specific username on a specific domain.
async function generateEduEmail({ alias, domainId } = {}) {
	const body =
		alias && domainId
			? { action: "custom", alias, domain_id: domainId }
			: { action: "random" };

	const res = await fetch(`${API_BASE}/emails/generate`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		throw new Error(`Email generation failed: HTTP ${res.status}`);
	}

	const json = await res.json();
	const email = json && json.data && json.data.email;
	if (!email || !email.address) {
		throw new Error(
			"Unexpected API response: " + JSON.stringify(json).slice(0, 300)
		);
	}

	return { address: email.address, uuid: email.uuid };
}

// Fetch the inbox for a given email UUID.
async function fetchInbox(uuid) {
	const res = await fetch(`${API_BASE}/emails/${uuid}`, {
		headers: { Accept: "application/json" },
	});
	if (!res.ok) {
		throw new Error(`Inbox fetch failed: HTTP ${res.status}`);
	}
	const json = await res.json();
	return (json && json.data && json.data.messages) || [];
}

// Poll the inbox until at least one message arrives (or we time out).
async function waitForMessages(uuid, { timeout = 120000, interval = 5000 } = {}) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		try {
			const messages = await fetchInbox(uuid);
			if (messages.length > 0) return messages;
		} catch (e) {
			console.warn("  (inbox poll error, retrying)", e.message);
		}
		await sleep(interval);
	}
	return [];
}

// ---- SINGLE TASK RUNNER -------------------------------------------------

async function runSingleTask(taskId = 1, { cliAlias, cliDomainId } = {}) {
	let browser;
	const tag = `[Task #${taskId}]`;
	const log = (...args) => console.log(tag, ...args);
	const warn = (...args) => console.warn(tag, ...args);
	const error = (...args) => console.error(tag, ...args);

	try {
		// --- STEP 1: GET A TEMPORARY EDU EMAIL FROM THE API ----------------
		log("Requesting a temporary edu email...");
		const { address: EMAIL, uuid } = await generateEduEmail({
			alias: cliAlias,
			domainId: cliDomainId,
		});
		log(`Generated email: ${EMAIL}`);
		log(`Inbox UUID: ${uuid}`);

		// --- STEP 2: LAUNCH BROWSER ----------------------------------------
		log("Launching browser...");
		browser = await puppeteer.launch({
			headless: "new", // Modern headless Chrome mode
			defaultViewport: { width: 1920, height: 1080 },
			args: [
				"--window-size=1920,1080",
				"--disable-blink-features=AutomationControlled", // reduce bot detection
				"--no-sandbox",
				"--disable-setuid-sandbox",
				"--no-default-browser-check",
				"--no-first-run",
			],
		});

		const page = await browser.newPage();

		// Set a realistic user agent to avoid being flagged as a bot
		await page.setUserAgent(
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
		);

		// Anti-detection document overrides
		await page.evaluateOnNewDocument(() => {
			Object.defineProperty(navigator, "webdriver", { get: () => undefined });
			Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
			Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
		});

		log(`Navigating to ${TARGET_URL} ...`);
		await page.goto(TARGET_URL, {
			waitUntil: "networkidle2",
			timeout: 60000,
		});
		log("Page loaded successfully.");

		// --- STEP 3: SMART DETECTION OF THE EMAIL FIELD --------------------
		log("Waiting for the email field to appear...");
		await page.waitForSelector(EMAIL_SELECTOR, {
			visible: true,
			timeout: 30000,
		});

		// Also make sure the field is enabled/ready to receive input.
		await page.waitForFunction(
			(sel) => {
				const el = document.querySelector(sel);
				return (
					el &&
					!el.disabled &&
					el.getAttribute("aria-disabled") !== "true"
				);
			},
			{ timeout: 30000 },
			EMAIL_SELECTOR
		);
		log("Email field is ready.");

		// --- STEP 4: ENTER THE EMAIL (direct input) ------------------------
		log(`Entering email directly: ${EMAIL}`);
		await directInput(page, EMAIL_SELECTOR, EMAIL);
		await humanPause(200, 500);
		log("Email entered successfully.");

		// --- STEP 5: CLICK THE "CONTINUE" BUTTON ---------------------------
		log("Waiting for the Continue button...");
		await page.waitForFunction(
			() => {
				const btns = Array.from(
					document.querySelectorAll('button[type="submit"]')
				);
				return btns.some((b) => {
					const label = (b.textContent || "").trim().toLowerCase();
					const enabled =
						!b.disabled &&
						b.getAttribute("aria-disabled") !== "true" &&
						b.getAttribute("aria-busy") !== "true";
					return label === "continue" && enabled;
				});
			},
			{ timeout: 30000 }
		);

		await humanPause(400, 1000);

		// Focus email selector and trigger submit via Enter & DOM click for headless/minimized reliability
		await page.evaluate((sel) => {
			const el = document.querySelector(sel);
			if (el) el.focus();
		}, EMAIL_SELECTOR);
		await page.keyboard.press("Enter");
		await page.evaluate(() => {
			const btns = Array.from(document.querySelectorAll('button[type="submit"]'));
			const btn = btns.find((b) => (b.textContent || "").trim().toLowerCase() === "continue");
			if (btn) btn.click();
		});
		log("Submitted Continue step.");

		// --- STEP 6: FILL THE SIGNUP FORM ----------------------------------
		const PASSWORD_SELECTOR = 'input[name="password"]';
		const FIRST_NAME_SELECTOR = 'input[name="firstName"]';
		const LAST_NAME_SELECTOR = 'input[name="lastName"]';

		log("Waiting for the signup fields to appear...");
		await page.waitForSelector(PASSWORD_SELECTOR, { timeout: 30000 });
		await page.waitForSelector(FIRST_NAME_SELECTOR, { timeout: 30000 });
		await page.waitForSelector(LAST_NAME_SELECTOR, { timeout: 30000 });

		const firstName = pick(FIRST_NAMES);
		const lastName = pick(LAST_NAMES);
		log(`Using name: ${firstName} ${lastName}`);

		// Fill each field human-like, with pauses between them.
		await humanPause(500, 1200);
		log("Typing password...");
		await humanType(page, PASSWORD_SELECTOR, PASSWORD);

		await humanPause(400, 900);
		log("Typing first name...");
		await humanType(page, FIRST_NAME_SELECTOR, firstName);

		await humanPause(400, 900);
		log("Typing last name...");
		await humanType(page, LAST_NAME_SELECTOR, lastName);

		await humanPause(500, 1200);

		// --- STEP 7: CLICK THE "SIGNUP" BUTTON / PRESS ENTER ----------------
		log("Waiting for the Signup button...");
		await page.waitForFunction(
			() => {
				const btns = Array.from(
					document.querySelectorAll('button[type="submit"]')
				);
				return btns.some((b) => {
					const label = (b.textContent || "").trim().toLowerCase();
					const enabled =
						!b.disabled &&
						b.getAttribute("aria-disabled") !== "true" &&
						b.getAttribute("aria-busy") !== "true";
					return label === "signup" && enabled;
				});
			},
			{ timeout: 30000 }
		);

		await humanPause(400, 1000);

		// Focus the last name field & press Enter (works when minimized / off-focus / headless)
		log("Focusing Last Name input and pressing Enter to submit...");
		await page.evaluate((sel) => {
			const el = document.querySelector(sel);
			if (el) el.focus();
		}, LAST_NAME_SELECTOR);
		await page.keyboard.press("Enter");

		// DOM click fallback to ensure submission even if Enter key is intercepted
		await page.evaluate(() => {
			const btns = Array.from(document.querySelectorAll('button[type="submit"]'));
			const btn = btns.find((b) => (b.textContent || "").trim().toLowerCase() === "signup");
			if (btn) btn.click();
		});
		log("Submitted the Signup form.");

		// --- STEP 8: WAIT FOR OTP FIELD & POLL INBOX FOR VERIFICATION CODE ---
		const OTP_SELECTOR =
			'input[data-input-otp="true"], input[autocomplete="one-time-code"]';

		log("Waiting for OTP input screen...");
		try {
			await page.waitForSelector(OTP_SELECTOR, {
				visible: true,
				timeout: 30000,
			});
			log("OTP input field detected.");
		} catch (e) {
			warn("OTP input field not immediately detected, proceeding to poll inbox...");
		}

		log("Waiting for the verification email to arrive in the inbox...");
		const messages = await waitForMessages(uuid, {
			timeout: 120000, // wait up to 2 minutes
			interval: 5000, // check every 5 seconds
		});

		if (messages.length === 0) {
			log("No messages arrived within the timeout window.");
			log(`You can check later with: GET ${API_BASE}/emails/${uuid}`);
		} else {
			log(`Received ${messages.length} message(s).`);

			// --- STEP 9: EXTRACT AND ENTER OTP CODE --------------------------
			const otpCode = extractOtp(messages);
			const verificationLink = extractVerificationLink(messages);

			if (otpCode) {
				log(`Extracted OTP code: ${otpCode}`);
				await humanPause(800, 1500);

				log("Focusing OTP input field...");

				// 1. Force DOM focus on the input element (bypasses pointer-events limitations)
				const focused = await page.evaluate((sel) => {
					const el = document.querySelector(sel);
					if (el) {
						el.focus();
						el.click();
						return true;
					}
					return false;
				}, OTP_SELECTOR);

				if (focused) {
					log(`Entering OTP code directly: ${otpCode}`);
					await directInput(page, OTP_SELECTOR, otpCode);
					log("OTP code entered into input field!");
				} else {
					warn("OTP input field could not be focused on page.");
				}
			} else {
				warn("No 6-digit OTP code found in received email(s).");
			}

			// --- STEP 10: AUTOMATIC VERIFICATION LINK FALLBACK ----------------
			if (verificationLink) {
				log(`Direct verification link found in email:\n  ${verificationLink}`);
				log("Navigating to verification link to complete account verification...");
				await humanPause(1000, 2000);
				await page.goto(verificationLink, {
					waitUntil: "networkidle2",
					timeout: 60000,
				});
				log("Navigated to verification link successfully!");
			}
		}

		// --- STEP 11: CREATE ORGANIZATION ----------------------------------
		log("Ensuring navigation to https://admin.mistral.ai/ ...");
		await humanPause(1500, 3000);
		if (!page.url().startsWith("https://admin.mistral.ai")) {
			await page.goto("https://admin.mistral.ai/", {
				waitUntil: "networkidle2",
				timeout: 60000,
			});
		}

		// Wait for Organization name input field
		const ORG_NAME_SELECTOR = 'input[name="name"], input[placeholder="My organization"]';
		log("Waiting for Organization name field...");
		await page.waitForSelector(ORG_NAME_SELECTOR, { visible: true, timeout: 30000 });

		// Generate a random uncommon organization name
		const UNCOMMON_ORG_NAMES = [
			"Apex Nebula Labs", "Zephyr Cybernetics", "Krypton Dynamics",
			"Vortex Synthetics", "Obsidian Quantum", "Hyperion Analytics",
			"Aetherial BioSystems", "Zenith Robotics", "Astraea Nexus",
			"Chrono Logic Systems", "Solstice Enterprise", "Eclipse Innovation"
		];
		const orgName = `${pick(UNCOMMON_ORG_NAMES)} ${rand(100, 999)}`;
		log(`Typing organization name: ${orgName}`);
		await humanPause(500, 1000);
		await humanType(page, ORG_NAME_SELECTOR, orgName);

		// Accept Terms of Service & Privacy Policy checkbox
		log("Accepting Terms of Service and Privacy Policy...");
		await humanPause(400, 800);
		await page.evaluate(() => {
			const termsInput = document.querySelector('input[name="terms"]');
			if (termsInput) {
				if (!termsInput.checked && termsInput.getAttribute('aria-checked') !== 'true') {
					const label = document.querySelector(`label[for="${termsInput.id}"]`) || termsInput;
					label.click();
				}
			}
		});

		// Wait until "Create organization" button is enabled
		log("Waiting for 'Create organization' button...");
		await page.waitForFunction(() => {
			const btns = Array.from(document.querySelectorAll('button[type="submit"]'));
			return btns.some((b) => {
				const label = (b.textContent || "").trim().toLowerCase();
				const enabled = !b.disabled && b.getAttribute("aria-disabled") !== "true";
				return label === "create organization" && enabled;
			});
		}, { timeout: 30000 });

		await humanPause(500, 1000);
		await page.keyboard.press("Enter");
		await page.evaluate(() => {
			const btns = Array.from(document.querySelectorAll('button[type="submit"]'));
			const btn = btns.find((b) => (b.textContent || "").trim().toLowerCase() === "create organization");
			if (btn) btn.click();
		});
		log("Submitted organization creation.");

		// --- STEP 12: NAVIGATE TO API KEYS PAGE -----------------------------
		log("Navigating to API Keys page...");
		await humanPause(2000, 4000);
		if (!page.url().includes("/organization/api-keys")) {
			await page.goto("https://admin.mistral.ai/organization/api-keys", {
				waitUntil: "networkidle2",
				timeout: 60000,
			});
		}
		log("API Keys page loaded.");

		// Wait for "New key" button on API Keys page
		log("Waiting for 'New key' button...");
		await page.waitForFunction(() => {
			const btns = Array.from(document.querySelectorAll("button"));
			return btns.some((b) => {
				const text = (b.textContent || "").trim().toLowerCase();
				return text.includes("new key");
			});
		}, { timeout: 30000 });

		await humanPause(500, 1000);
		await page.evaluate(() => {
			const btns = Array.from(document.querySelectorAll("button"));
			const btn = btns.find((b) => (b.textContent || "").trim().toLowerCase().includes("new key"));
			if (btn) btn.click();
		});
		log("Clicked 'New key' button.");

		// --- STEP 13: MODAL - SELECT WORKSPACE & CREATE KEY ----------------
		log("Waiting for Create new key modal...");
		await page.waitForSelector('[role="dialog"]', { timeout: 30000 });
		log("Modal opened.");

		await humanPause(600, 1200);

		// Locate and click the Workspace combobox inside modal
		log("Opening Workspace selector...");
		const workspaceBtnHandle = await page.evaluateHandle(() => {
			const dialog = document.querySelector('[role="dialog"]');
			if (!dialog) return null;

			// Match label with text 'Workspace' then find its associated combobox button
			const labels = Array.from(dialog.querySelectorAll('label'));
			const wsLabel = labels.find(l => (l.textContent || '').trim().toLowerCase() === 'workspace');
			if (wsLabel) {
				const forId = wsLabel.getAttribute('for');
				if (forId) {
					const target = dialog.querySelector(`#${forId}`) || document.getElementById(forId);
					if (target) return target;
				}
				// Look for sibling/parent combobox
				const parentDiv = wsLabel.closest('div');
				if (parentDiv) {
					const btn = parentDiv.querySelector('button[role="combobox"]');
					if (btn) return btn;
				}
			}

			// Fallback: first button with role combobox inside modal
			const btns = Array.from(dialog.querySelectorAll('button[role="combobox"]'));
			return btns.find((b) => (b.textContent || "").toLowerCase().includes("select workspace")) || btns[0];
		});

		const workspaceEl = workspaceBtnHandle.asElement();
		if (workspaceEl) {
			// Check if already open
			const isOpen = await page.evaluate((el) => {
				return el.getAttribute('aria-expanded') === 'true' || el.getAttribute('data-state') === 'open';
			}, workspaceEl);

			if (!isOpen) {
				await workspaceEl.click();
				log("Clicked Workspace dropdown button.");
			} else {
				log("Workspace dropdown button is already open.");
			}
		} else {
			warn("Workspace combobox button not found in modal.");
		}

		await humanPause(600, 1200);

		// Select "Default" workspace option from dropdown menu portal
		log("Selecting 'Default' workspace from dropdown...");
		let selectedDefault = false;

		try {
			// Wait for menu options to appear
			await page.waitForFunction(() => {
				const items = Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"], [data-radix-collection-item], [cmdk-item]'));
				if (items.length > 0) return true;
				// Or check for leaf text nodes containing default
				const leafs = Array.from(document.querySelectorAll('*')).filter(el => el.children.length === 0);
				return leafs.some(el => (el.textContent || '').trim().toLowerCase().includes('default'));
			}, { timeout: 5000 });

			selectedDefault = await page.evaluate(() => {
				// Search explicit role items first
				const roleItems = Array.from(document.querySelectorAll(
					'[role="option"], [role="menuitem"], [role="menuitemradio"], [data-radix-collection-item], [cmdk-item]'
				));
				let target = roleItems.find(el => {
					const txt = (el.textContent || "").trim().toLowerCase();
					return txt === "default" || txt.includes("default");
				});

				// Fallback: search leaf DOM elements to avoid matching parent container divs
				if (!target) {
					const candidates = Array.from(document.querySelectorAll('div, span, button, p, li'));
					target = candidates.find(el => {
						const txt = (el.textContent || "").trim().toLowerCase();
						const isLeaf = el.children.length === 0 || (el.children.length === 1 && el.children[0].tagName === 'SVG');
						return isLeaf && (txt === "default" || txt === "default workspace" || txt.startsWith("default"));
					});
				}

				if (target) {
					target.scrollIntoView({ block: 'nearest' });
					target.click();
					target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
					target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
					target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
					return true;
				}
				return false;
			});
		} catch (e) {
			warn("DOM selection for 'Default' option failed or timed out:", e.message);
		}

		if (selectedDefault) {
			log("Selected 'Default' workspace option successfully.");
		} else {
			warn("Using keyboard fallback to select 'Default' workspace...");
			await page.keyboard.press("ArrowDown");
			await sleep(200);
			await page.keyboard.press("Enter");
		}

		await humanPause(800, 1500);

		// Click "New key" submit button in modal
		log("Clicking 'New key' submit button in modal...");
		await page.evaluate(() => {
			const dialog = document.querySelector('[role="dialog"]');
			if (!dialog) return;
			const btns = Array.from(dialog.querySelectorAll('button[type="submit"], button'));
			const btn = btns.find((b) => (b.textContent || "").trim().toLowerCase() === "new key");
			if (btn) {
				btn.click();
			} else {
				const form = dialog.querySelector("form");
				if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
			}
		});
		log("Submitted 'New key' modal form.");

		// --- STEP 14: EXTRACT API KEY AND SAVE TO TXT FILE -----------------
		log("Waiting for API key created modal...");
		await page.waitForFunction(() => {
			const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
			return dialogs.some(d => {
				const txt = (d.textContent || "").toLowerCase();
				return txt.includes("api key created") || d.querySelector('input[readonly]');
			});
		}, { timeout: 30000 });

		log("API key created modal detected. Extracting key...");

		const apiKey = await page.evaluate(() => {
			const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
			const targetDialog = dialogs.find(d => (d.textContent || "").toLowerCase().includes("api key created")) || dialogs[dialogs.length - 1];
			if (!targetDialog) return null;

			const input = targetDialog.querySelector('input[readonly], input[value]');
			if (input && input.value) {
				return input.value.trim();
			}
			return null;
		});

		if (apiKey) {
			log(`==================================================`);
			log(`SUCCESS! Extracted API Key: ${apiKey}`);
			log(`==================================================`);

			const outputLine = `${apiKey}\n`;
			const filePath = "api_keys.txt";
			fs.appendFileSync(filePath, outputLine, "utf-8");
			log(`API Key saved successfully to file: ${filePath}`);
		} else {
			warn("Could not extract API key value from modal input.");
		}

		// Click "Done" button to close modal
		log("Clicking 'Done' button in modal...");
		const doneClicked = await page.evaluate(() => {
			const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
			const targetDialog = dialogs.find(d => (d.textContent || "").toLowerCase().includes("api key created")) || dialogs[dialogs.length - 1];
			if (!targetDialog) return false;

			const btns = Array.from(targetDialog.querySelectorAll('button'));
			const doneBtn = btns.find(b => (b.textContent || "").trim().toLowerCase() === "done");
			if (doneBtn) {
				doneBtn.click();
				return true;
			}
			return false;
		});

		if (doneClicked) {
			log("Clicked 'Done' button successfully.");
		} else {
			warn("Could not find 'Done' button in modal.");
		}

		await humanPause(1000, 2000);
		log("Task completed successfully. Closing browser...");
		if (browser) {
			await browser.close();
		}
		return { success: true, apiKey, email: EMAIL };
	} catch (err) {
		error("Something went wrong:", err.message);
		if (browser) {
			try {
				await browser.close();
			} catch (_) {}
		}
		return { success: false, error: err.message };
	}
}

// ---- PARALLEL WORKER POOL -----------------------------------------------

async function runParallelPool(totalTasks, concurrency) {
	console.log(`\n==================================================`);
	console.log(`STARTING PARALLEL EXECUTION`);
	console.log(`Total Accounts to Process: ${totalTasks}`);
	console.log(`Max Concurrent Threads:   ${concurrency}`);
	console.log(`==================================================\n`);

	let completedCount = 0;
	let successCount = 0;
	let failCount = 0;
	let currentTaskIndex = 0;

	async function worker(workerId) {
		while (currentTaskIndex < totalTasks) {
			const taskId = ++currentTaskIndex;
			console.log(`[Worker #${workerId}] Picking up Task #${taskId} of ${totalTasks}...`);
			const result = await runSingleTask(taskId);
			completedCount++;
			if (result.success && result.apiKey) {
				successCount++;
				console.log(`[Worker #${workerId}] Task #${taskId} FINISHED SUCCESSFULLY -> Key: ${result.apiKey}`);
			} else {
				failCount++;
				console.warn(`[Worker #${workerId}] Task #${taskId} FAILED -> Error: ${result.error || "Unknown"}`);
			}
		}
	}

	const pool = [];
	for (let i = 1; i <= Math.min(concurrency, totalTasks); i++) {
		pool.push(worker(i));
	}

	await Promise.all(pool);

	console.log(`\n==================================================`);
	console.log(`ALL PARALLEL TASKS COMPLETED`);
	console.log(`Total Requested: ${totalTasks}`);
	console.log(`Successful:     ${successCount}`);
	console.log(`Failed:         ${failCount}`);
	console.log(`API Keys saved to api_keys.txt`);
	console.log(`==================================================\n`);
}

// ---- MAIN ENTRY POINT ---------------------------------------------------

(async () => {
	const arg2 = process.argv[2];
	const arg3 = process.argv[3];

	// Check if parallel parameters are passed:
	// Usage examples:
	//   node run.js                    -> 1 task single run
	//   node run.js 5                  -> 5 tasks, 5 parallel concurrency
	//   node run.js 10 3               -> 10 tasks, 3 max parallel concurrency
	//   node run.js --parallel 4       -> 4 tasks, 4 parallel concurrency
	//   node run.js john 1             -> 1 task with custom alias john & domainId 1

	let isParallelMode = false;
	let totalTasks = 1;
	let concurrency = 1;

	if (arg2 === "--parallel" || arg2 === "-p" || arg2 === "--count" || arg2 === "-c") {
		isParallelMode = true;
		totalTasks = arg3 ? parseInt(arg3, 10) : 3;
		concurrency = process.argv[4] ? parseInt(process.argv[4], 10) : totalTasks;
	} else if (arg2 && !isNaN(parseInt(arg2, 10)) && (!arg3 || !isNaN(parseInt(arg3, 10)))) {
		isParallelMode = true;
		totalTasks = parseInt(arg2, 10);
		concurrency = arg3 ? parseInt(arg3, 10) : totalTasks;
	}

	if (isParallelMode && totalTasks > 1) {
		await runParallelPool(totalTasks, concurrency);
		process.exit(0);
	} else {
		// Single run mode (retains full compatibility with custom alias & domainId)
		const cliAlias = (arg2 && isNaN(parseInt(arg2, 10))) ? arg2 : undefined;
		const cliDomainId = arg3 ? parseInt(arg3, 10) : undefined;
		const res = await runSingleTask(1, { cliAlias, cliDomainId });
		process.exit(res.success ? 0 : 1);
	}
})();
