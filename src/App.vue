<script lang="ts">
import { Converter } from 'showdown'
import { encode, decode } from 'gpt-tokenizer'
import { Readability } from '@mozilla/readability'

import Loader from './components/Loader.vue'

export default {
	name: 'PageSummary',
	components: { Loader },
	data() {
		return {
			id: chrome.runtime.id,
			//apiHost: 'http://localhost:8787',
			apiHost: 'https://pocket.layered.workers.dev',
			distinct_id: crypto.randomUUID(),
			reqController: null,

			view: 'summary',

			// webpage data
			status: 'saving',
			page: {
				id: null,
				url: '',
				type: null,
				title: null,
				site_name: null,
				locale: null,
				byline: null,
				excerpt: '',
				image: null,
				icon: null,
				content: '',
				content_status: 'missing',
				summary: null,
			},

			// summary data
			summary_status: 'extracting-content',
			aiOptions: {
				model: 'openai-gpt-3.5-turbo',
				promptTemplate: '2-5-bullet-points',
				language: '',
			},

			// similar data
			similar_status: 'loading',
			similar: [],

			error: '',
		}
	},
	created() {
		this.loadSettings()
		this.checkTab()
	},
	methods: {
		loadSettings() {
			chrome.storage.sync.get(['distinct_id', 'model', 'template', 'language']).then((kv) => {
				console.log('got KV', kv)

				if (kv.distinct_id) {
					this.distinct_id = kv.distinct_id
				} else {
					chrome.storage.sync.set({ distinct_id: this.distinct_id })
				}

				if (kv.template && kv.template !== this.aiOptions.promptTemplate) {
					this.aiOptions.promptTemplate = kv.template
				}

				if (kv.language && kv.language !== this.aiOptions.language) {
					this.aiOptions.language = kv.language
				}

				if (kv.model && kv.model !== this.aiOptions.model) {
					this.aiOptions.model = kv.model
				}
			})
		},
		async checkTab() {
			const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
			console.log('tab', tab)

			this.page.url = tab.url
			this.page.title = tab.title
			this.page.icon = tab.favIconUrl

			function extractPageContent() {
				console.log('Summarize', window.location.hostname, document.contentType, document.title)

				return {
					contentType: document.contentType,
					document: new XMLSerializer().serializeToString(document),
					page: {
						url: document.querySelector('link[rel="canonical"]')?.getAttribute('href'),
						type: document.querySelector('meta[property="og:type"]')?.getAttribute('content'),
						title: document.querySelector('meta[property="og:title"]')?.getAttribute('content') || document.title,
						site_name: document.querySelector('meta[property="og:site_name"]')?.getAttribute('content'),
						locale: document.querySelector('meta[property="og:locale"]')?.getAttribute('content'),
						excerpt: document.querySelector('meta[property="og:description"]')?.getAttribute('content') || document.querySelector('meta[name="description"]')?.getAttribute('content'),
						image: document.querySelector('meta[property="og:image"]')?.getAttribute('content'),
					},
				}
			}

			const setContent = (replies: any[]) => {
				const data = replies[0].result

				if (data.contentType === 'application/pdf' || data.contentType.startsWith('image/') || data.contentType.startsWith('video/')) {
					setTimeout(() => {
						this.saveUrl()
					}, 3000)
				} else if (data.contentType === 'text/html') {
					// set found page data
					this.page = { ...this.page, ...data.page }

					// extract content with Readability
					const doc = new DOMParser().parseFromString(data.document, "text/html");
					const article = new Readability(doc).parse();

					if (article?.content) {
						this.page.content = String(article.content).trim()
						this.page.type ||= 'article'

						if (!this.page.excerpt && article.excerpt) {
							this.page.excerpt = article.excerpt
						}

						if (!this.page.locale && article.lang) {
							this.page.locale = article.lang
						}

						if (!this.page.site_name && article.siteName) {
							this.page.site_name = article.siteName
						}

						if (article.byline) {
							this.page.byline = article.byline.trim()
						}
					}

					this.saveWebpage()
				} else {
					this.status = 'error'
					this.summary_status = 'error'
					this.error = `Unsupported content type "${data.contentType}"`
				}
			}

			chrome.scripting.executeScript({
				target: { tabId: tab.id },
				func: extractPageContent,
			}, setContent);
		},

		setView(view: string) {
			this.view = view
		},

		saveWebpage() {
			this.status = 'saving'

			fetch(`${this.apiHost}/pockets/${this.distinct_id}/save-webpage`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(this.page),
			}).then(response => {
				console.log('save-webpage response', response.ok, response.status, response.statusText)

				if (response.ok) {
					return response.json()
				} else {
					throw new Error(response.statusText)
				}
			}).then(item => {
				console.log('save-webpage item', item)
				this.page.id = item.id
				this.page.content_status = item.content_status
				this.status = 'saved'

				if (item.content_status === 'ready') {
					this.summary_status = 'summarizing'
					this.summarize()
					this.loadSimilar()
				} else {
					this.summary_status = 'no-content'
				}
			}).catch(error => {
				this.status = 'error'
				console.error('save-webpage error', error)
			})
		},
		saveUrl() {
			this.status = 'saving'

			fetch(`${this.apiHost}/pockets/${this.distinct_id}/save-url`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(this.page),
			}).then(response => {
				console.log('save-url response', response.ok, response.status, response.statusText)

				if (response.ok) {
					return response.json()
				} else {
					throw new Error(response.statusText)
				}
			}).then(item => {
				console.log('save-url item', item)
				this.page.id = item.id
				this.page.content_status = item.content_status
				this.status = 'saved'

				if (item.content_status === 'ready') {
					this.summary_status = 'summarizing'
					this.summarize()
					this.loadSimilar()
				} else {
					this.summary_status = 'no-content'
				}
			}).catch(error => {
				this.status = 'error'
				this.summary_status = 'error'
				this.error = error.message
				console.error('save-url error', error)
			})
		},

		summarize() {
			console.log('Start summarize', this.page.content.length)

			if (this.status === 'saving') {
				return
			}

			if (this.page.content.length < 200) {
				this.summary_status = 'no-content'
				return
			}

			this.summary_status = 'summarizing'

			console.log('Summarize', this.page)

			if (this.reqController) {
				this.reqController.abort()
			}

			this.reqController = new AbortController();

			let model = this.aiOptions.model
			let content = this.page.content

			if (this.aiOptions.model.startsWith('openai-')) {
				const contentTokens = encode(content)

				if (contentTokens.length > 15000) {
					content = decode(contentTokens.slice(0, 15000))
				}
			}

			fetch(`${this.apiHost}/items/${this.page.id}/summary?model=${model}&template=${this.aiOptions.promptTemplate}&language=${this.aiOptions.language}`, {
				signal: this.reqController.signal,
			}).then(response => {
				console.log('response summarize', response.status)

				if (response.ok) {
					return response.text()
				} else {
					response.text().then(text => {
						console.log('summarize error', text)
						this.error = text
					})

					throw new Error(response.statusText)
				}
			}).then(data => {
				const converter = new Converter()
				this.page.summary = converter.makeHtml(data.trim())
				this.summary_status = 'ready'
			}).catch(error => {
				if (error.name !== 'AbortError') {
					console.error('summarize error', error)
					this.summary_status = 'error'
					this.error = error.message
				}
			}).finally(() => {
				this.reqController = null
			})
		},
		loadSimilar() {
			this.similar_status = 'loading'

			fetch(`${this.apiHost}/pockets/${this.distinct_id}/items/${this.page.id}/similar`).then(response => {
				console.log('response similar', response.ok, response.status, response.statusText, response.headers.get('content-type'))

				return response.json()
			}).then(similar => {
				this.similar = similar
				this.similar_status = 'loaded'
			}).catch(error => {
				if (error.name !== 'AbortError') {
					console.error('similar error', error)
					this.similar_status = 'error'
				}
			})
		},
		parsedUrl(url: string) {
			return new URL(url)
		},
		urlHostname(url: string) {
			const parsed = new URL(url)

			return parsed.hostname.startsWith('www.') ? parsed.hostname.slice(4) : parsed.hostname
		}
	},
	watch: {
		'aiOptions.model': function (model) {
			console.log('change model', model)
			chrome.storage.sync.set({ model })
			this.summarize()
		},
		'aiOptions.promptTemplate': function (template) {
			chrome.storage.sync.set({ template })
			this.summarize()
		},
		'aiOptions.language': function (language) {
			console.log('changed language', language)

			if (language) {
				chrome.storage.sync.set({ language })
			} else {
				chrome.storage.sync.remove('language')
			}
			this.summarize()
		},
	}
}
</script>

<template>
	<div class="app-screen">
		<div class="flex gap-3 items-center py-4 px-3">
			<h1 class="grow text-xl font-semibold">{{ page.title }}</h1>

			<a :href="`${apiHost}/pockets/${distinct_id}/items?redirect=app`" target="_blank" class="inline-block min-w-24 text-center bg-slate-50/90 hover:bg-neutral-50/70 rounded p-1 text-sm font-medium text-slate-800 hover:text-slate:950">
				View library
			</a>
		</div>

		<div class="flex text-center">
			<div class="flex-1 py-3 cursor-pointer" :class="view === 'summary' ? 'font-bold bg-slate-50/70 backdrop-opacity-30' : 'hover:bg-slate-100 font-medium'" @click="setView('summary')">
				Summary
			</div>
			<div class="flex-1 py-3 cursor-pointer" :class="view === 'similar' ? 'font-bold bg-slate-50/70 backdrop-opacity-30' : 'hover:bg-slate-100 font-medium'" @click="setView('similar')">
				Similar <span class="bg-indigo-100 dark:bg-indigo-900 p-1 ml-1 rounded" :class="similar.length ? 'text-indigo-900 dark:text-indigo-100' : 'text-neutral-700 dark:text-neutral-300'">{{ similar.length }}</span>
			</div>
		</div>

		<div class="p-3 pb-4 bg-slate-50/70 backdrop-opacity-30">

			<template v-if="view === 'summary'">
				<div class="grid grid-cols-3 gap-3 mb-4">
					<label class="text-slate-600 text-center">
						AI Model:
						<select v-model="aiOptions.model" class="w-full rounded bg-slate-200/50 border-0 p-1 text-slate-900">
							<option value="anthropic-claude-3-sonnet-20240229">Claude 3</option>
							<option value="google-gemini-pro">Gemini 1 Pro</option>
							<option value="openai-gpt-3.5-turbo">GPT 3.5 Turbo</option>
							<option value="@cf/meta/llama-2-7b-chat-int8">Llama 2 7B</option>
						</select>
					</label>

					<label class="text-slate-600 text-center">
						Format:
						<select v-model="aiOptions.promptTemplate" class="w-full rounded bg-slate-200/50 border-0 p-1 text-slate-900">
							<option value="short-paragraph">Short paragraph</option>
							<option value="medium-paragraph">Medium paragraph</option>
							<option value="2-5-bullet-points">Bullet points</option>
						</select>
					</label>

					<label class="text-slate-600 text-center">
						Language:
						<select v-model="aiOptions.language" class="w-full rounded bg-slate-200/50 border-0 p-1 text-slate-900">
							<option value="">No change</option>
							<hr>
							<option value="arabic">Arabic</option>
							<option value="english">English</option>
							<option value="french">French</option>
							<option value="japanese">Japanese</option>
							<option value="russian">Russian</option>
							<option value="spanish">Spanish</option>
							<hr>
							<option value="got-dothraki">Dothraki</option>
							<option value="lotr-elvish">Elvish</option>
							<option value="klingon">Klingon</option>
						</select>
					</label>
				</div>

				<div v-if="status === 'saving' || summary_status === 'extracting-content'" class="text-center">
					Extracting content..
				</div>
				<div v-else-if="summary_status === 'summarizing'" class="text-center">
					<Loader :text="'Summarizing'"></Loader>
				</div>
				<div v-else-if="summary_status === 'no-content'" class="text-center text-red-500">
					This page is not an article, so it can't be summarized..
				</div>
				<div v-else-if="summary_status === 'ready'">
					<div class="page-summary" v-html="page.summary"></div>
				</div>
				<div v-else class="text-center text-red-700 text-lg">
					Error summarizing this page ({{ error }})
				</div>
			</template>
			<template v-else>
				<div v-if="similar_status === 'loading'" class="text-center py-4">
					<Loader :text="'Loading'"></Loader>
				</div>
				<div v-else-if="similar_status === 'error'" class="text-center text-red-700 py-4">
					Error loading similar items ({{ error }})
				</div>
				<div v-else-if="!similar.length" class="text-center text-blue-800 py-4">
					Save more pages, so we can start showing you similar ones.
				</div>
				<div v-else-if="similar.length" class="grid grid-cols-3 gap-3">
					<a v-for="item in similar" :key="item.id" :href="item.url" target="_blank" class="bg-white hover:bg-slate-50 rounded" :class="{'row-span-2': item.image}">
						<img v-if="item.image" :src="item.image" class="w-full h-24 object-cover rounded-t" :alt="item.title">

						<h3 class="mt-2 mb-2 px-3" :class="item.title.length > 50 ? 'font-bold' : 'font-medium text-lg'">{{ item.title }}</h3>

						<p class="mb-2 px-3">{{ item.excerpt }}</p>

						<p class="px-3 text-neutral-600 mb-3">
							<img v-if="item.icon" :src="item.icon" class="inline w-4 h-4 object-cover" :alt="item.site_name || item.title">
							{{ urlHostname(item.url) }}
						</p>
					</a>
				</div>
			</template>
		</div>
		

		<!-- <pre>{{ page }}</pre> -->
	</div>
</template>

<style>
.page-summary > * {
	margin-bottom: 0.7rem;
}

.page-summary > h1,
.page-summary > h2,
.page-summary > h3,
.page-summary > h4,
.page-summary > h5,
.page-summary > h6 {
	font-weight: 600;

}

.page-summary > *:last-child {
	margin-bottom: 0;
}

.page-summary ul {
	list-style: disc;
}

.page-summary ul li {
	margin-left: 1em;
	margin-bottom: 0.2rem;
	line-height: 1.5em;
}
</style>
