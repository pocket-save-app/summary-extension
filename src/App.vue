<script lang="ts">
import { isYouTubeVideoUrl } from '@layered/superurl'
import { Readability } from '@mozilla/readability'
import { isPlainObject } from 'lodash-es'
import { Converter } from 'showdown'

import Loader from './components/Loader.vue'

const blockedHostnames = [
	'gemini.google.com',
	'mail.google.com',
	'mail.yahoo.com',
	'outlook.live.com',
	'outlook.office.com',
]

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

const apiHost = 'https://pocket-api.unallow.com'
//const apiHost = 'http://localhost:8787'

async function apiFetch(path: string, options: RequestInit = {}): Promise<ResponseWithData> {
	const url = new URL(path, apiHost)

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
			error: '',
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

			// ask ai
			messages: [],
			prompts: new Set(['Short summary', 'Bullet points', 'Explain it like I\'m 5',]),
			askStatus: 'idle',
			newMessage: '',

			// similar data
			similar_status: 'idle',
			similar: [],
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
				console.log('[Snapshot]', 'took a snapshot of the DOM', {
					hostname: window.location.hostname,
					contentType: document.contentType,
					title: document.title,
				})

				return {
					contentType: document.contentType,
					document: new XMLSerializer().serializeToString(document),
					page: {
						url: document.querySelector('link[rel="canonical"]')?.getAttribute('href') || window.location.href,
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

					const isYoutubeVideo = isYouTubeVideoUrl(this.page.url)

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

			if (['drive.google.com', 'docs.google.com'].includes(url.hostname)) {
				window.open('https://myhono.com/integration-coming-soon?integration=google-drive', '_blank')
			} else if (blockedHostnames.includes(url.hostname)) {
				window.open('https://myhono.com/try-other-website', '_blank')
			} else {
				this.loadMessagesPrompts()

				chrome.scripting.executeScript({
					target: { tabId: tab.id },
					func: extractPageContent,
				}, setContent);
			}
		},

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
					this.loadMessages()
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
		pocketItemSave() {
			console.log('[hono]', this.page.id, 'save in pocket')
			this.status = 'saving'

			apiFetch(`pockets/${this.distinct_id}/items/${this.page.id}`, {
				method: 'put',
				body: {
					status: 'saved'
				},
			}).then(() => {
				this.status = 'saved'
			}).catch(console.warn)
		},
		pocketItemRemove() {
			console.log(this.page.id, 'remove from pocket')
			this.status = 'deleting'

			apiFetch(`pockets/${this.distinct_id}/items/${this.page.id}`, {
				method: 'put',
				body: {
					status: 'deleted'
				},
			}).then(() => {
				this.status = 'deleted'
			}).catch(console.warn)
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

		loadMessagesPrompts() {
			console.log(this.distinct_id, 'Load prompts')

			apiFetch(`pockets/${this.distinct_id}/prompts`)
				.then(({ data: prompts }) => {
					prompts.forEach(prompt => this.prompts.add(prompt))
				}).catch(error => {
					console.warn(this.distinct_id, 'load prompts ERROR', error)
				})
		},
		loadMessages() {
			console.log(this.page.id, 'Load messages')

			apiFetch(`pockets/${this.distinct_id}/items/${this.page.id}/messages`)
				.then(({ data: messages }) => {
					this.messages.push(...messages)
					setTimeout(() => {
						this.$refs.messages.scrollTop = this.$refs.messages.scrollHeight
					}, 50)
				}).catch(error => {
					console.warn(this.page.id, 'load messages ERROR', error)
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

		askAi(msg: string = null) {
			this.askStatus = 'loading'
			const $messages = this.$refs.messages

			this.messages.push({
				role: 'user',
				content: msg || this.newMessage,
			})

			setTimeout(() => {
				$messages.scrollTop = $messages.scrollHeight
			}, 50)

			const evtSource = new EventSource(`${apiHost}/pockets/${this.distinct_id}/items/${this.page.id}/messages-stream?message=${encodeURIComponent(msg || this.newMessage)}`);

			evtSource.onmessage = (event) => {
				if (this.askStatus === 'loading') {
					this.messages.push({
						role: 'assistant',
						content: event.data,
						streaming: true,
					})

					this.askStatus = 'idle'
				} else {
					this.messages.at(-1).content += event.data

					setTimeout(() => {
						$messages.scrollTop = $messages.scrollHeight
					}, 50)
				}
			}

			// close connection after meta message
			evtSource.addEventListener("meta", (event) => {
				console.log('[hono]', 'msg meta', event.data)
				evtSource.close()

				this.messages.at(-1).streaming = false

				setTimeout(() => {
					$messages.scrollTop = $messages.scrollHeight
				}, 50)
			})

			this.pocket.ai_messages += 1
			this.newMessage = ''
		},

		urlHostname(url: string) {
			const parsed = new URL(url)

			return parsed.hostname.startsWith('www.') ? parsed.hostname.slice(4) : parsed.hostname
		}
	},
}
</script>

<template>
	<div class="app-screen">
		<div class="flex gap-3 mx-3 pt-2 pb-4 items-center">
			<h1 class="grow text-2xl line-clamp-1">{{ page.title }}</h1>

			<div class="flex-none text-stone-500">
				<Loader v-if="status === 'saving'" :text="'saving'"></Loader>
				<p v-else-if="status === 'saved'"><u class="text-stone-600 cursor-pointer" @click="pocketItemRemove">Remove</u></p>
				<Loader v-else-if="status === 'deleting'" :text="'removing'"></Loader>
				<p v-else-if="status === 'deleted'"><u class="text-stone-600 cursor-pointer" @click="pocketItemSave">Undo</u></p>
				<code v-else>status={{ status }}</code>
			</div>

			<a :href="`https://myhono.com/set-pocket/${distinct_id}`" target="_blank" class="flex-none py-1 px-3 inline-block rounded-md bg-amber-600 hover:bg-amber-500 text-white transition-all">
				View library
			</a>
		</div>

		<div class="flex text-center border-b border-stone-200">
			<button class="flex-1 py-3 border-b-2 mb-[-1px]" :class="view === 'ask' ? 'font-bold border-orange-200 text-amber-600' : 'border-transparent text-neutral-700 font-medium hover:font-semibold'" @click="setView('ask')">
				Ask
			</button>
			<button class="flex-1 py-3 border-b-2 mb-[-1px]" :class="view === 'similar' ? 'font-bold border-orange-200 text-amber-600' : 'border-transparent text-neutral-700 font-medium hover:font-semibold'" @click="setView('similar')">
				Similar <span v-if="Array.isArray(similar) && similar.length" class="p-1 ml-1 rounded bg-orange-100 text-amber-600">{{ similar.length }}</span>
			</button>
		</div>

		<!-- 
		<div class="flex text-center">
			<div class="flex-1 py-3 cursor-pointer" :class="view === 'ask' ? 'font-bold bg-pocket' : 'hover:bg-stone-100 font-medium'" @click="setView('ask')">
				Ask
			</div>
			<div class="flex-1 py-3 cursor-pointer" :class="view === 'similar' ? 'font-bold bg-pocket' : 'hover:bg-stone-100 font-medium'" @click="setView('similar')">
				Similar <span v-if="Array.isArray(similar) && similar.length" class="bg-indigo-100 dark:bg-indigo-900 p-1 ml-1 rounded" :class="similar.length ? 'text-indigo-900 dark:text-indigo-100' : 'text-neutral-700 dark:text-neutral-300'">{{ similar.length }}</span>
			</div>
		</div>
 		-->

		<div v-show="view === 'ask'" class="overflow-y-auto h-80 pb-14" ref="messages">
			<div v-for="message in messages" class="mx-3 message" :class="{'mt-2': message.role === 'user'}">
				<p v-if="message.role === 'user'" class="text-stone-800 text-lg mb-1">{{ message.content }}</p>
				<div v-else class="text-slate-800 mb-3">
					<div v-html="converter.makeHtml(message.content)" class="chat-response"></div>
					<p v-if="message.content.length > 100 && !message.streaming" class="text-neutral-500 mt-1">
						<small class="text-slate-600 hover:text-slate-800">Read Aloud</small>
						&middot;
						<small class="text-slate-600 hover:text-slate-800 cursor-pointer" @click="$event => copyText($event, message.content)">Copy</small>
					</p>
				</div>
			</div>

			<Loader v-if="askStatus === 'loading'" class="mx-3" :text="''"></Loader>
			<p v-else-if="askStatus === 'error'" class="mx-3 text-red-500">Error connecting to the mainframe</p>

			<div v-if="!messages.length" class="flex items-center h-64">
				<div class="mx-3">
					<p class="text-slate-700 mb-2">Try these prompts:</p>

					<div class="flex items-center gap-3">
						<button v-for="prompt in prompts" @click="askAi(prompt)" class="rounded-full p-2 px-3 bg-amber-50 border border-dashed border-amber-200 text-amber-900 text-[14px] hover:border-solid hover:bg-amber-100">
							{{ prompt }}
						</button>
					</div>

					<p class="text-slate-700 mt-2">Or ask below ⤵</p>
				</div>
			</div>

			<form @submit.prevent="askAi()" class="absolute left-3 right-3 bottom-2 flex items-center g-2 border border-stone-200 bg-white focus-within:border-stone-300 focus-within:shadow-md rounded-lg">
				<input class="grow p-2 pl-3 text-lg bg-transparent border-0 focus-visible:outline-0" ref="q" v-model="newMessage" required minlength="2" :placeholder="messages.length ? 'Ask follow-up' : `Ask anything about this ${this.page.type || 'website'}`">

				<div v-if="!messages.length" class="pr-2">
					<button class="bg-amber-600 text-white rounded-lg border-0 p-2" :disabled="!page.id">Start chat</button>
				</div>
				<div v-else-if="newMessage.length > 1" class="pr-2">
					<button class="bg-amber-600 text-white rounded-lg border-0 py-2 px-3">⬆</button>
				</div>
			</form>
		</div>

		<div v-show="view === 'similar'">
			<div v-if="similar_status === 'loading'" class="text-center py-6">
				<Loader :text="'Loading'"></Loader>
			</div>
			<div v-else-if="similar_status === 'error'" class="text-center text-red-700 py-4">
				Error loading similar items ({{ error }})
			</div>
			<div v-else-if="!similar.length" class="text-center text-blue-800 py-4">
				Save more articles, videos or images, so we can start showing you similar ones.
			</div>
			<div v-else-if="similar.length" class="p-3 divide-y divide-stone-100">
				<div v-for="item in similar" class="flex items-center gap-x-3 md:px-0 border-stone-200 bg-transparent py-2">
					<a :href="item.url" target="_blank" class="block min-w-24">
						<img v-if="item.source === 'url' && item.image" :src="item.image" :alt="item.title" class="w-24 h-24 rounded-lg object-cover" />
						<img v-else-if="item.source === 'url-file' && item.type.startsWith('image/')" :src="`https://pocket-api.unallow.com/items/${item.id}/file`" :alt="item.title" class="w-24 h-24 rounded-lg object-cover" />
						<div v-else class="w-24 h-20 rounded-lg bg-slate-100 border border-slate-200"></div>
					</a>

					<div>
						<a :href="item.url" target="_blank" class="block mb-1">
							<p class="text-stone-800 font-semibold mb-1">{{ item.title }}</p>
							<p class="text-stone-600 break-word text-balance line-clamp-2">{{ item.excerpt }}</p>
						</a>
						<p class="text-stone-500">
							Similarity: <span v-if="item.score >= 0.7" class="rounded px-1 bg-green-100 text-green-800" :title="item.score">High</span><span v-else-if="item.score >= 0.4" :title="item.score" class="rounded px-1 bg-orange-100 text-orange-800">Medium</span><span v-else :title="item.score" class="rounded px-1 bg-red-100 text-red-800">Low</span>
							<!-- &middot;
							<small>{{ new Date(item.updated_at).toLocaleString('default', { dateStyle: 'medium', timeStyle: 'short' }) }}</small> -->
							&middot;
							<a :href="item.url" target="_blank" class="text-stone-700">{{ urlHostname(item.url) }}</a>
						</p>
					</div>
				</div>
			</div>
		</div>
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
