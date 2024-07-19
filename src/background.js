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
});

const key = "openaikey";
