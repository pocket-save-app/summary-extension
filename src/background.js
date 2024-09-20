let pocketId = null

chrome.storage.sync.get('distinct_id').then((kv) => {
	if (kv.distinct_id) {
		pocketId = kv.distinct_id
	} else {
		pocketId = crypto.randomUUID()
		chrome.storage.sync.set({ distinct_id: pocketId })
	}
})

chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
	if (typeof message === 'string' && message === 'get-pocket-id') {
		sendResponse(pocketId)
	}
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
		title: 'Save in Snapshot',
		contexts: ['link', 'page']
	});
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
	if (info.menuItemId === 'snapshot-link') {
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

		chrome.tabs.create({ url: `https://pocket-web.unallow.com/set-pocket/${pocketId}` });
	}
});
