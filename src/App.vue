<script lang="ts">
import { urlIsYoutube } from '@layered/superurl'
import { Readability } from '@mozilla/readability'
import { isPlainObject } from 'lodash-es'
import { Converter } from 'showdown'

import Loader from './components/Loader.vue'

class HttpError extends Error {
	response: Response

	constructor(response: Response) {
		super(`HTTP Error ${response.status} ${response.statusText}`)
		this.response = response
	}
}

interface ResponseWithData extends Response {
	data?: any
}

async function apiFetch(path: string, options: RequestInit = {}): Promise<ResponseWithData> {
	const url = new URL(path, 'https://pocket-api.unallow.com')

	options.headers = new Headers({
		'authorization': `Bearer ${import.meta.env.VITE_API_TOKEN}`,
		'x-platform': 'chrome_extension',
		'x-version': '1.9.0',
		...(options.headers || {}),
	})

	// helper: change method to POST if body is present
	if (options.body) {
		options.method ||= 'POST'

		// check if body can be stringified
		console.log('body type', options.body.constructor.name)
		if (Array.isArray(options.body) || isPlainObject(options.body)) {
			options.body = JSON.stringify(options.body)

			if (!options.headers.has('content-type')) {
				options.headers.set('content-type', 'application/json')
			}
		}
	}

	const response: ResponseWithData = await fetch(url, options)

	// prepare Response data
	response.data = response.headers.get('content-type')?.startsWith('application/json') ? await response.json() : await response.text()

	if (!response.ok) {
		throw new HttpError(response)
	}

	return response
}

export default {
	name: 'PageSummary',
	components: { Loader },
	data() {
		return {
			id: chrome.runtime.id,
			distinct_id: null,
			converter: new Converter(),

			view: 'ask',

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
			},

			// summary data
			aiOptions: {
				promptTemplate: '3-5 bullet points',
				language: '',
			},

			// similar data
			similar_status: 'idle',
			similar: [],

			// ask ai
			messages: [],
			askStatus: 'idle',
			newMessage: '',

			error: '',
		}
	},
	created() {
		this.checkTab()
	},
	mounted() {
		this.$refs.q.focus()
	},
	methods: {
		async checkTab() {
			const [ tabs, id ] = await Promise.all([
				chrome.tabs.query({ active: true, lastFocusedWindow: true }),
				chrome.runtime.sendMessage('get-pocket-id')
			])

			const [ tab ] = tabs
			this.distinct_id = id

			console.log('[Snapshot]', 'tab', tab)

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
					this.saveUrl()
				} else if (data.contentType === 'text/html') {
					// set found page data
					this.page = { ...this.page, ...data.page }

					const isYoutubeVideo = urlIsYoutube(this.page.url)

					if (!isYoutubeVideo) {
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
					}

					this.saveWebpage()
				} else {
					this.status = 'error'
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

			if (view === 'ask') {
				setTimeout(() => {
					this.$refs.q.focus()
				}, 50)
			}
		},

		saveWebpage() {
			this.status = 'saving'

			apiFetch(`pockets/${this.distinct_id}/save-webpage`, {
				body: this.page,
			}).then(({ data: item }) => {
				console.log('save-webpage item', item)
				this.page.id = item.id
				this.page.content_status = item.content_status
				this.status = 'saved'

				if (item.content_status === 'ready') {
					this.loadSimilar()
				}
			}).catch(error => {
				this.status = 'error'
				console.error('save-webpage error', error)
			})
		},
		saveUrl() {
			this.status = 'saving'

			apiFetch(`pockets/${this.distinct_id}/save-url`, {
				body: this.page,
			}).then(({ data: item }) => {
				console.log('save-url item', item)
				this.page.id = item.id
				this.page.type = item.type
				this.page.content_status = item.content_status
				this.status = 'saved'

				if (item.content_status === 'ready') {
					this.loadSimilar()
				}
			}).catch(error => {
				console.error('save-url error', error)

				this.status = 'error'
				this.error = error.message
			})
		},

		copyText(event: MouseEvent, text: string) {
			navigator.clipboard.writeText(text)

			const target = event.target as HTMLElement
			const originalText = target.textContent
			target.textContent = 'Copied!'

			setTimeout(() => {
				target.textContent = originalText
			}, 1500)
		},

		askAiSummarize() {
			let msg = `Summarize as ${this.aiOptions.promptTemplate}`
			if (this.aiOptions.language) {
				msg += ` in ${this.aiOptions.language}`
			}
			this.askAi(msg)
		},
		askAi(msg: string = null) {
			this.askStatus = 'loading'
			const $messages = this.$refs.messages

			this.messages.push({
				role: 'user',
				content: msg || this.newMessage,
			})

			this.newMessage = ''

			if ($messages) {
				setTimeout(() => {
					$messages.scrollTop = $messages.scrollHeight
				}, 50)
			}

			apiFetch(`pockets/${this.distinct_id}/items/${this.page.id}/messages`, {
				body: this.messages,
			}).then(({ data: message }) => {
				console.log('message', message)

				this.messages.push({
					role: 'assistant',
					content: message.trim(),
				})

				this.askStatus = 'idle'

				if ($messages) {
					setTimeout(() => {
						$messages.scrollTop = $messages.scrollHeight
					}, 50)
				}
			}).catch(error => {
				this.askStatus = 'error'
				console.warn('messages error', error)
			})
		},

		loadSimilar() {
			console.log(this.page.id, 'Load similar')
			this.similar_status = 'loading'

			apiFetch(`pockets/${this.distinct_id}/items/${this.page.id}/similar?expand=item`)
				.then(({ data: similar }) => {
					this.similar = similar
					this.similar_status = 'loaded'
				}).catch(error => {
					console.warn('similar error', error)
					this.similar_status = 'error'
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
		'aiOptions.promptTemplate': function (template) {
			chrome.storage.sync.set({ template })
		},
		'aiOptions.language': function (language) {
			console.log('changed language', language)

			if (language) {
				chrome.storage.sync.set({ language })
			} else {
				chrome.storage.sync.remove('language')
			}
		},
	}
}
</script>

<template>
	<div class="app-screen">
		<div class="flex gap-3 items-center py-4 px-3">
			<h1 class="grow text-xl font-semibold">{{ page.title }}</h1>

			<a :href="`https://pocket-web.unallow.com/set-pocket/${distinct_id}`" target="_blank" class="inline-block min-w-32 text-center bg-slate-50/90 hover:bg-neutral-50/70 rounded p-1 text-sm font-medium text-slate-800 hover:text-slate:950">
				View your library
			</a>
		</div>

		<div class="flex text-center">
			<div class="flex-1 py-3 cursor-pointer" :class="view === 'ask' ? 'font-bold bg-pocket' : 'hover:bg-stone-100 font-medium'" @click="setView('ask')">
				Ask
			</div>
			<div class="flex-1 py-3 cursor-pointer" :class="view === 'similar' ? 'font-bold bg-pocket' : 'hover:bg-stone-100 font-medium'" @click="setView('similar')">
				Similar <span v-if="Array.isArray(similar) && similar.length" class="bg-indigo-100 dark:bg-indigo-900 p-1 ml-1 rounded" :class="similar.length ? 'text-indigo-900 dark:text-indigo-100' : 'text-neutral-700 dark:text-neutral-300'">{{ similar.length }}</span>
			</div>
		</div>

		<div class="p-3 pb-4 bg-pocket">
			<div v-show="view === 'ask'">
				<div v-if="messages.length" ref="messages" class="overflow-y-auto h-72">
					<div v-for="message in messages">
						<p v-if="message.role === 'user'" class="text-stone-800 text-lg mb-1">{{ message.content }}</p>
						<div v-else class="text-slate-800 mb-3">
							<div v-html="converter.makeHtml(message.content)" class="mb-1 chat-response"></div>
							<p class="text-neutral-500">
								<small class="text-slate-600 hover:text-slate-800">Read Aloud</small>
								&middot;
								<small class="text-slate-600 hover:text-slate-800 cursor-pointer" @click="$event => copyText($event, message.content)">Copy</small>
							</p>
						</div>
					</div>

					<Loader v-if="askStatus === 'loading'" :text="''"></Loader>
					<p v-else-if="askStatus === 'error'" class="text-red-500">Error connecting to the mainframe</p>
				</div>
				<!-- <div v-else class="h-24 mt-28 mb-20 bg-white/80 border border-dashed border-white/50 rounded"> -->
				<div v-else class="flex items-center gap-3 h-72">
					<!-- <p class="text-slate-800 p-4">Ask anything about this website</p> -->

					<form @submit.prevent="askAiSummarize" class="inline-block rounded-full p-2 pl-3 bg-amber-50 border border-dashed border-amber-300/60 text-orange-900 text-md">
						Summarize as <select v-model="aiOptions.promptTemplate" class="rounded bg-orange-200/20 border-0 text-orange-800">
							<option>short paragraph</option>
							<option>medium paragraph</option>
							<option value="3-5 bullet points">bullet points</option>
						</select> in <select v-model="aiOptions.language" class="rounded bg-orange-200/20 border-0 text-orange-800">
							<option value="">original language</option>
							<hr>
							<option>Arabic</option>
							<option>English</option>
							<option>French</option>
							<option>Japanese</option>
							<option>Russian</option>
							<option>Spanish</option>
							<hr>
							<option value="Dothraki (got)">Dothraki</option>
							<option value="Elvish (lotr)">Elvish</option>
							<option>Klingon</option>
						</select> <button class="inline-block ml-2 bg-orange-200 rounded-full text-center text-orange-800 w-6 h-6">Go</button>
					</form>

					<div @click="askAi('Explain like I\'m five')" class="cursor-pointer inline-block rounded-full p-2 pl-3 bg-cyan-50 border border-dashed border-cyan-300/50 text-cyan-900 text-md">
						Explain like I'm 5 <button class="inline-block ml-2 bg-cyan-200 rounded-full text-center text-cyan-800 w-6 h-6">Go</button>
					</div>
				</div>

				<form @submit.prevent="askAi()" class="flex items-center g-2 border border-stone-200 bg-white focus-within:border-stone-300 focus-within:shadow-md rounded-lg mt-2">
					<input class="grow p-2 pl-3 text-lg bg-transparent border-0 focus-visible:outline-0" ref="q" v-model="newMessage" required minlength="2" :placeholder="messages.length ? 'Ask follow-up' : `Ask anything about this ${this.page.type || 'website'}`">

					<div v-if="!messages.length" class="pr-2">
						<button class="bg-amber-600 text-white rounded-lg border-0 p-2">Start chat</button>
					</div>
					<div v-else-if="newMessage.length > 1" class="pr-2">
						<button class="bg-amber-600 text-white rounded-lg border-0 py-2 px-3">⬆</button>
					</div>
				</form>
			</div>

			<div v-show="view === 'similar'">
				<div v-if="similar_status === 'loading'" class="text-center py-4">
					<Loader :text="'Loading'"></Loader>
				</div>
				<div v-else-if="similar_status === 'error'" class="text-center text-red-700 py-4">
					Error loading similar items ({{ error }})
				</div>
				<div v-else-if="!similar.length" class="text-center text-blue-800 py-4">
					Save more articles, videos or images, so we can start showing you similar ones.
				</div>
				<div v-else-if="similar.length" class="grid grid-cols-3 gap-3">
					<a v-for="item in similar" :key="item.id" :href="item.url" target="_blank" class="bg-white hover:bg-slate-50 rounded" :class="{'row-span-2': item.image}">
						<img v-if="item.source === 'url' && item.image" :src="item.image" class="w-full h-24 object-cover rounded-t" :alt="item.title">
						<img v-else-if="['file', 'url-file'].includes(item.source) && item.type.startsWith('image/')" :src="`https://pocket.layered.workers.dev/items/${item.id}/file`" class="w-full h-24 object-cover rounded-t" :alt="item.title">

						<h3 class="mt-2 mb-2 px-3" :class="item.title.length > 50 ? 'font-bold' : 'font-medium text-lg'">{{ item.title }}</h3>

						<p v-if="item.excerpt" class="mb-2 px-3">{{ item.excerpt }}</p>

						<p class="px-3 text-neutral-600 mb-3">
							<img v-if="item.icon" :src="item.icon" class="inline w-4 h-4 object-cover" :alt="item.site_name || item.title">
							{{ urlHostname(item.url) }}
						</p>
					</a>
				</div>
			</div>
		</div>
		

		<!-- <pre>{{ page }}</pre> -->
	</div>
</template>

<style>
.chat-response > * {
	margin-bottom: 0.5rem;
}

.chat-response > h1,
.chat-response > h2,
.chat-response > h3,
.chat-response > h4,
.chat-response > h5,
.chat-response > h6 {
	font-weight: 600;

}

.chat-response > *:last-child {
	margin-bottom: 0;
}

.chat-response ul {
	list-style: disc;
}

.chat-response ul li {
	margin-left: 1em;
	margin-bottom: 0.2rem;
	line-height: 1.5em;
}
</style>
