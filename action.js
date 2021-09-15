const _ = require('lodash')
const core = require('@actions/core')
const github = require('@actions/github')
const YAML = require('yaml')
const Jira = require('./common/net/Jira')
const J2M = require('./lib/J2M')

const issueIdRegEx = /([a-zA-Z0-9]+-[0-9]+)/g

const startJiraToken = 'JIRA-ISSUE-TEXT-START'
const endJiraToken = 'JIRA-ISSUE-TEXT-END'

const eventTemplates = {
    branch: '{{event.ref}}',
    commits: "{{event.commits.map(c=>c.message).join(' ')}}",
}

const {
    context
} = github

async function getPreviousReleaseRef(octo) {
    if (!context.repository || !octo) {
        return
    }
    const releases = await octo.repos.getLatestRelease({
        ...context.repo,
    })

    const {
        tag_name
    } = releases.payload

    return tag_name
}

function upperCaseFirst(str) {
    return str.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substr(1))
}

module.exports = class {
    constructor({
        githubEvent,
        argv,
        config
    }) {
        this.Jira = new Jira({
            baseUrl: config.baseUrl,
            token: config.token,
            email: config.email,
        })
        this.jiraUrl = config.baseUrl
        this.J2M = new J2M()
        core.debug(`Config found: ${JSON.stringify(config)}`)
        core.debug(`Args found: ${JSON.stringify(argv)}`)
        this.config = config
        this.argv = argv
        this.githubEvent = githubEvent || context.payload
        this.github = null
        this.updatePRTitle = argv.updatePRTitle
        this.commitMessageList = null
        this.foundKeys = null
        this.jiraTransition = null
        this.transitionChain = []
        if (argv.transitionChain) {
            this.transitionChain = argv.transitionChain.split(',')
        }

        if (context.eventName === 'pull_request') {
            if (context.payload.action in ['closed'] && context.payload.pull_request.merged === 'true') {
                this.jiraTransition = argv.transitionOnPrMerge
            } else if (context.payload.action in ['opened']) {
                this.jiraTransition = argv.transitionOnPrOpen
            }
        } else if (context.eventName === 'pull_request_review') {
            if (context.payload.state === 'APPROVED') {
                this.jiraTransition = argv.transitionOnPrApproval
            }
        } else if (context.eventName in ['create']) {
            this.jiraTransition = argv.transitionOnNewBranch
        }

        this.github = new github.GitHub(argv.githubToken) || null

        if (Object.prototype.hasOwnProperty.call(githubEvent, 'pull_request')) {
            this.headRef = githubEvent.pull_request.head.ref || null
            this.baseRef = githubEvent.pull_request.base.ref || null
        } else if (Object.prototype.hasOwnProperty.call(githubEvent, 'ref')) {
            this.headRef = githubEvent.ref || null
            this.baseRef = null
        }
        if (context.eventName === 'pull_request') {
            this.headRef = this.headRef || context.payload.pull_request.head.ref || null
            this.baseRef = this.baseRef || context.payload.pull_request.base.ref || null
        } else if (context.eventName === 'push') {
            if (context.payload.ref.startsWith('refs/tags')) {
                this.baseRef = this.baseRef || getPreviousReleaseRef(this.github)
            }
            this.headRef = this.headRef || context.payload.ref || null
        }
        this.headRef = argv.headRef || this.headRef || null
        this.baseRef = argv.baseRef || this.baseRef || null
    }

    async updateStringByToken(startToken, endToken, fullText, insertText) {
        const regex = new RegExp(
            `(?<start>\\[\\/]: \\/ "${startToken}"\\n)(?<text>(?:.|\\s)+)(?<end>\\n\\[\\/]: \\/ "${endToken}"(?:\\s)?)`,
            'gm',
        )

        if (regex.test(fullText)) {
            return fullText.replace(regex, `$1${insertText}$3`)
        }

        return `${fullText.trim()}\n\n[/]: / "${startToken}"\n${insertText}\n[/]: / "${endToken}"`
    }

    async updatePullRequestBody(startToken, endToken) {
        if (!this.githubEvent.pull_request && !context.payload.pull_request) {
            core.debug(
                `Skipping pull request update, pull_request not found in current github context, or received event`,
            )

            return
        }
        const issues = await this.formattedIssueList()
        const text = `### Jira Issues:\n\n${issues}\n`

        const { number, body, title } = this.githubEvent.pull_request || context.payload.pull_request

        core.debug(`Updating PR number ${number}`)
        core.debug(`With text:\n ${text}`)

        let newTitle = title.trim()

        if (this.updatePRTitle) {
            core.debug(`Current PR Title: ${title}`)

            const issueKeys = this.foundKeys.map((a) => a.get('key'))

            if (Array.isArray(issueKeys)) {
                try {
                    const re = /(?:\[)?(?<issues>(?:(?:[\w]{2,8})(?:[-_ ])(?:[\d]{3,5})(?:[, ]+)?)+)(?:[-:_ \]]+)(?<title>.*)?/

                    const { groups } = newTitle.match(re)
                    const groupTitle = (groups.title || '').trim()

                    core.debug(`The title match found: ${YAML.stringify(groups)}`)

                    newTitle = `${issueKeys.join(', ')}: ${upperCaseFirst(groupTitle)}`.slice(0, 71)
                    core.setOutput('title', `${upperCaseFirst(groupTitle)}`)
                } catch (error) {
                    core.warning("catch 1 >>")
                    core.warning(error)
                    core.warning("<< catch 1")
                }
            }
        }
        if (issues) {
            const bodyUpdate = await this.updateStringByToken(startToken, endToken, body, text)

            await this.github.pulls.update({
                ...context.repo,
                title: newTitle,
                body: bodyUpdate,
                pull_number: number,
            })
        }
    }

    async getJiraKeysFromGitRange() {
        let match = null

        if (!(this.baseRef && this.headRef)) {
            core.debug('Base ref and head ref not found')

            return
        }
        core.debug(`Getting list of github commits between ${this.baseRef} and ${this.headRef}`)
        // This will work fine up to 250 commit messages
        const commits = await this.github.repos.compareCommits({
            ...context.repo,
            base: this.baseRef,
            head: this.headRef,
        })

        if (!commits || !commits.data) {
            return
        }
        const fullArray = []

        const {
            title
        } = this.githubEvent.pull_request || context.payload.pull_request

        if (title) {
            match = title.match(issueIdRegEx)

            if (match) {
                for (const issueKey of match) {
                    fullArray.push(issueKey)
                }
            }
        }

        match = this.headRef.match(issueIdRegEx)
        if (match) {
            for (const issueKey of match) {
                fullArray.push(issueKey)
            }
        }
        for (const item of commits.data.commits) {
            if (item.commit && item.commit.message) {
                match = item.commit.message.match(issueIdRegEx)
                if (match) {
                    let skipCommit = false

                    if (
                        item.commit.message.startsWith('Merge branch') ||
                        item.commit.message.startsWith('Merge pull')
                    ) {
                        if (!this.argv.includeMergeMessages) {
                            skipCommit = true
                        }
                    }

                    if (skipCommit === false) {
                        for (const issueKey of match) {
                            fullArray.push(issueKey)
                        }
                    }
                }
            }
        }
        // Make the array Unique
        const uniqueKeys = [...new Set(fullArray.map((a) => a.toUpperCase()))]

        core.debug(`Unique Keys: ${uniqueKeys}\n`)
        // Verify that the strings that look like key match real Jira keys
        this.foundKeys = []
        for (const issueKey of uniqueKeys) {
            // Version 3 includes Sprint information, but description is in Atlassian Document Format
            // Which is used only by atlassian, and we need a converter to Markdown.
            // Version 2 uses Atlassian RichText for its Descriptions,
            // and this can be converted to Markdown
            // TODO: Harass Atlassian about conversion between their own products
            const issue = await this.Jira.getIssue(issueKey, {}, '3')
            const issueV2 = await this.Jira.getIssue(issueKey, {
                fields: ['description', 'sprint']
            }, '2')
            const issueObject = new Map()

            if (issue) {
                core.debug(`Issue ${issue.key}: \n${YAML.stringify(issue)}`)
                issueObject.set('key', issue.key)
                try {
                    issueObject.set('projectName', issue.fields.project.name)
                    core.debug(`Jira ${issue.key} project name: ${issue.fields.project.name}`)
                    issueObject.set('projectKey', issue.fields.project.key)
                    core.debug(`Jira ${issue.key} project key: ${issue.fields.project.key}`)
                    issueObject.set('priority', issue.fields.priority.name)
                    core.debug(`Jira ${issue.key} priority: ${issue.fields.priority.name}`)
                    issueObject.set('status', issue.fields.status.name)
                    core.debug(`Jira ${issue.key} status: ${issue.fields.status.name}`)
                    issueObject.set('statusCategory', issue.fields.status.statusCategory.name)
                    core.debug(`Jira ${issue.key} statusCategory: ${issue.fields.status.statusCategory.name}`)
                    if (Array.isArray(issue.fields.customfield_11306)) {
                        // Assigned to
                        core.debug(
                            `Jira ${issue.key} displayName: ${issue.fields.customfield_11306[0].displayName}`,
                        )
                    }
                    issueObject.set('summary', issue.fields.summary)
                    core.debug(`Jira ${issue.key} summary: ${issue.fields.summary}`)
                    if (issueV2.fields.description) {
                        issueObject.set('descriptionJira', issueV2.fields.description)
                        issueObject.set('description', this.J2M.toM(issueV2.fields.description))
                    }
                    if (issue.fields.sprint) {
                        issueObject.set('sprint', issue.fields.sprint.name)
                        issueObject.set('duedate', issue.fields.sprint.endDate)
                        core.debug(`Jira ${issue.key} sprint: \n${YAML.stringify(issue.fields.sprint)}`)
                    }
                    if (issueV2.fields.sprint) {
                        issueObject.set('sprint', issueV2.fields.sprint.name)
                        issueObject.set('duedate', issueV2.fields.sprint.endDate)
                        core.debug(`Jira ${issue.key} sprint: \n${YAML.stringify(issueV2.fields.sprint)}`)
                    }

                    // issue.fields.comment.comments[]
                    // issue.fields.worklog.worklogs[]
                } finally {
                    try {
                        issueObject.set('ghNumber', await this.jiraToGitHub(issueObject))
                    } catch (error) {
                        core.error(error)
                    }
                    this.foundKeys.push(issueObject)
                }
            }
        }
        core.debug(`Found Jira Keys  : ${this.foundKeys.map((a) => a.get('key'))}\n`)
        core.debug(`Found GitHub Keys: ${this.foundKeys.map((a) => a.get('ghNumber'))}\n`)

        return this.foundKeys
    }

    async transitionIssues() {
        for (const a of this.foundKeys) {
            const issueId = a.get('key')

            if (this.jiraTransition && this.transitionChain) {
                const {
                    transitions
                } = await this.Jira.getIssueTransitions(issueId)
                const idxJT = this.transitionChain.indexOf(this.jiraTransition)

                for (let i = 0; i < idxJT; i++) {
                    const link = this.transitionChain[i]

                    const transitionToApply = _.find(transitions, (t) => {
                        if (t.id === link) return true
                        if (t.name.toLowerCase() === link.toLowerCase()) return true
                    })

                    if (transitionToApply) {
                        core.info(`Applying transition:${JSON.stringify(transitionToApply, null, 4)}`)
                        await this.Jira.transitionIssue(issueId, {
                            transition: {
                                id: transitionToApply.id,
                            },
                        })
                    }
                }
            }
            const transitionedIssue = await this.Jira.getIssue(issueId)
            const statusName = _.get(transitionedIssue, 'fields.status.name')

            core.debug(`Jira ${issueId} status is: ${statusName}.`)
            core.debug(`Link to issue: ${this.config.baseUrl}/browse/${issueId}`)
            a.set('status', statusName)
        }
    }

    async formattedIssueList() {
        return this.foundKeys
            .map(
                (a) =>
                `*  **[${a.get('key')}](${this.jiraUrl}/browse/${a.get('key')})** [${a.get(
            'status',
            'Jira Status Unknown',
          )}] ${a.get('summary')} (Fix: #${a.get('ghNumber')})`,
            )
            .join('\n')
    }

    async outputReleaseNotes() {
        const issues = await this.formattedIssueList()

        core.setOutput('notes', `### Release Notes:\n\n${issues}`)
    }

    async execute() {
        const issues = await this.getJiraKeysFromGitRange()

        if (issues) {
            await this.transitionIssues()
            await this.updatePullRequestBody(startJiraToken, endJiraToken)
            await this.outputReleaseNotes()

            return issues
        }

        const template = eventTemplates[this.argv.from] || this.argv._.join(' ')
        const extractString = this.preprocessString(template)

        if (!extractString) {
            core.warning(`This github event is not compatible with this usage.`)

            return
        }
        const match = extractString.match(issueIdRegEx)

        if (!match) {
            core.warning(`String "${extractString}" does not contain issueKeys`)

            return
        }

        for (const issueKey of match) {
            const issue = await this.Jira.getIssue(issueKey)

            if (issue) {
                core.debug(`Jira issue: ${JSON.stringify(issue)}`)

                return new Map(['key', issue.key])
            }
        }
    }

    preprocessString(str) {
        try {
            _.templateSettings.interpolate = /{{([\s\S]+?)}}/g
            const tmpl = _.template(str)

            return tmpl({
                event: this.githubEvent
            })
        } catch (error) {
            core.error(error)
        }
    }
}