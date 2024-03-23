<script lang="ts">
export default {
	name: 'Loader',
    props: {
        text: {
            type: String,
            default: 'Loading',
        }
    },
    data() {
        return {
            indicator: 1,
            timer: null,
        }
    },
	created() {
		this.timer = setInterval(() => {
            this.indicator++
            if (this.indicator > 3) {
                this.indicator = 1
            }
        }, 500)
	},
    beforeUnmount() {
        clearInterval(this.timer)
    },
}
</script>

<template>
    <span>{{ text }}{{ '.'.repeat(indicator) }}</span>
</template>