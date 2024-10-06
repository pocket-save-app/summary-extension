let pocketId = null

async function getPocketId() {
	if (!pocketId) {
		const kv = await chrome.storage.sync.get('distinct_id')

		if (kv.distinct_id) {
			pocketId = kv.distinct_id
		} else {
			pocketId = crypto.randomUUID()
			chrome.storage.sync.set({ distinct_id: pocketId })
		}
	}

	return pocketId
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (typeof message === 'string' && message === 'get-pocket-id') {
		getPocketId().then(sendResponse)
	}

	return true
});

chrome.runtime.onInstalled.addListener((details) => {
	console.log('onInstalled...', details);

	// disable extension action
	chrome.action.disable();

	// enable extension action on valid domains
	chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {

		// rules: tabs with valid domains
		const rules = [{
			conditions: [
				new chrome.declarativeContent.PageStateMatcher({
					pageUrl: {schemes: ['http', 'https']},
				})
			],
			actions: [new chrome.declarativeContent.ShowAction()],
		}];

		chrome.declarativeContent.onPageChanged.addRules(rules);
	});

	chrome.contextMenus.create({
		id: 'snapshot-link',
		title: 'Save in Hono',
		contexts: ['link', 'page']
	});
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
	if (info.menuItemId === 'snapshot-link') {
		getPocketId().then((pocketId) => {
			fetch(`https://pocket-api.unallow.com/pockets/${pocketId}/save-url`, {
				method: 'POST',
				body: JSON.stringify({ url: info.linkUrl }),
				headers: {
					'authorization': `Bearer ${import.meta.env.VITE_API_TOKEN}`,
					'content-type': 'application/json',
					'x-platform': 'chrome_extension',
					'x-version': '1.10.0',
				},
			})
	
			chrome.tabs.create({ url: `https://myhono.com/set-pocket/${pocketId}` });
		})
	}
});
