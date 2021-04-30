const _ = require('lodash')
const core = require('@actions/core')
const github = require('@actions/github')
const YAML = require('yaml')
const Jira = require('./common/net/Jira')
const J2M = require('./lib/J2M')
const {
  getPreviousReleaseRef,
  upperCaseFirst,
  context,
  issueIdRegEx,
  startJiraToken,
  endJiraToken,
  eventTemplates,
} = require('./utils')

module.exports = class {
  constructor({ githubEvent, argv, config }) {
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
    this.createIssue = argv.createIssue
    this.updatePRTitle = argv.updatePRTitle
    this.commitMessageList = null
    this.foundKeys = []
    this.githubIssues = []
    this.jiraTransition = null
    this.createGist = false
    this.gist_private = config.gist_private
    this.transitionChain = []
    this.fixVersion = argv.fixVersion
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
    if (argv.githubToken) {
      this.github = new github.GitHub(argv.githubToken) || null
    }
    if (config.gist_name) this.createGist = true
  }

  // if (context.payload.action in ['closed'] && context.payload.pull_request.merged === 'true')

  async findGithubMilestone(issueMilestone) {
    if (!issueMilestone) {
      return
    }
    const milestones = await this.github.issues.listMilestonesForRepo({
      ...context.repo,
      state: 'all',
    })

    for (const element of milestones.data) {
      if (element.title === issueMilestone.toString()) {
        core.debug(`Existing milestone found: ${element.title}`)

        return element
      }
    }
    core.debug(`Existing milestone not found.`)
  }

  async createOrUpdateMilestone(issueMilestone, issueMilestoneDueDate, issueMilestoneDescription) {
    if (!issueMilestone) {
      return
    }
    let milestone = await this.findGithubMilestone(issueMilestone)

    if (milestone) {
      this.github.issues.updateMilestone({
        ...context.repo,
        milestone_number: milestone.number,
        description: issueMilestoneDescription,
        state: 'open',
        due_on: issueMilestoneDueDate,
      })

      return milestone.number
    }

    milestone = await this.github.issues.createMilestone({
      ...context.repo,
      title: `${issueMilestone}`,
      description: issueMilestoneDescription,
      state: 'open',
      // YYYY-MM-DDTHH:MM:SSZ
      due_on: issueMilestoneDueDate,
    })

    return milestone.number
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
    const text = `### Linked Jira Issues:\n\n${issues}\n`

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

          core.debug(`The title match found: ${YAML.stringify(groups)}`)

          newTitle = `${issueKeys.join(', ')}: ${upperCaseFirst(groups.title.trim())}`.slice(0, 71)
          core.setOutput('title', `${upperCaseFirst(groups.title.trim())}`)
        } catch (error) {
          core.warning(error)
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

  async createOrUpdateGHIssue(issueKey, issueTitle, issueBody, issueAssignee, milestoneNumber) {
    core.debug(`Getting list of issues`)
    const issues = await this.github.issues.listForRepo({
      ...context.repo,
      state: 'open',
    })
    let issueNumber = null

    core.debug(`Checking for ${issueKey} in list of issues`)
    for (const i of issues.data) {
      if (!i.pull_request && i.title && i.title.contains(issueKey)) {
        issueNumber = i.issue_number
        break
      }
    }

    let issue = null

    if (issueNumber) {
      core.debug(`Updating ${issueKey} with issue number ${issueNumber}`)
      issue = await this.github.issues.update({
        ...context.repo,
        issue_number: issueNumber,
        title: `${issueKey}: ${issueTitle}`,
        body: issueBody,
        assignees: [],
        // assignees: issueAssignee ? [issueAssignee] : null,
        milestone: milestoneNumber,
      })
    } else {
      core.debug(`Creating ${issueKey}`)
      issue = await this.github.issues.create({
        ...context.repo,
        title: `${issueKey}: ${issueTitle}`,
        body: issueBody,
        assignees: [],
        // assignees: issueAssignee ? [issueAssignee] : null,
        milestone: milestoneNumber,
      })
    }

    this.githubIssues.push(issue.data.number)

    core.debug(`Github Issue: \n${YAML.stringify(issue.data)}`)

    return issue.data.number
  }

  async jiraToGitHub(jiraIssue) {
    // Get or set milestone from issue
    // for (let version of jiraIssue.fixVersions) {
    core.debug(
      `JiraIssue is in project ${jiraIssue.get('projectKey')} Fix Version ${this.fixVersion}`,
    )

    const msNumber = await this.createOrUpdateMilestone(
      this.fixVersion || null,
      jiraIssue.get('duedate'),
      `Jira project ${jiraIssue.get('projectKey')} Fix Version ${this.fixVersion}`,
    )

    // set or update github issue
    const ghNumber = await this.createOrUpdateGHIssue(
      jiraIssue.get('key'),
      jiraIssue.get('summary'),
      jiraIssue.get('description'),
      msNumber,
    )

    return ghNumber
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

    const { title } = this.githubEvent.pull_request || context.payload.pull_request

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
            core.debug('Commit message indicates that it is a merge')
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
      const issueV2 = await this.Jira.getIssue(
        issueKey,
        { fields: ['description', 'fixVersions'] },
        '2',
      )
      const issueObject = new Map()

      if (issue) {
        core.debug(`Issue ${issue.key}: \n${YAML.stringify(issue)}`)
        issueObject.set('key', issue.key)
        const _fixVersions = new Set(issue.fields.fixVersions?.map((f) => f.name))
        if (this.fixVersion) {
          if (!_fixVersions.has(this.fixVersion)) {
            _fixVersions.add(this.fixVersion)
            // this.Jira.updateIssue()
            // Update the Jira Issue to include the fix version and Project
          }
        }
        const fixVersions = Array.from(_fixVersions)

        try {
          issueObject.set('key', issue.key)
          if (Array.isArray(issue.fields.customfield_10500)) {
            // Pull Request
            core.debug(
              `Jira ${issue.key} linked pull request: ${issue.fields.customfield_10500[0]}`,
            )
          }
          issueObject.set('projectName', issue.fields.project.name)
          core.debug(`Jira ${issue.key} project name: ${issue.fields.project.name}`)
          issueObject.set('fixVersions', fixVersions)
          core.debug(`Jira ${issue.key} fixVersions name: ${issue.fields.project.name}`)
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
            core.debug(`JiraV2 ${issue.key} sprint: \n${YAML.stringify(issueV2.fields.sprint)}`)
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
    core.debug(`TransitionIssues: Number of keys ${this.foundKeys.length}`)
    for (const a of this.foundKeys) {
      const issueId = a.get('key')
      core.debug(`TransitionIssues: Checking transition for ${issueId}`)
      if (this.jiraTransition && this.transitionChain) {
        const { transitions } = await this.Jira.getIssueTransitions(issueId)
        core.debug(
          `TransitionIssues: Transitions available for ${issueId}:
          ${YAML.stringify(transitions)}`,
        )
        const idxJT = this.transitionChain.indexOf(this.jiraTransition)

        for (let i = 0; i < idxJT; i++) {
          const link = this.transitionChain[i]

          const transitionToApply = _.find(transitions, (t) => {
            if (t.id === link) return true
            if (t.name.toLowerCase() === link.toLowerCase()) return true
          })

          if (transitionToApply) {
            core.info(`Applying transition:${YAML.stringify(transitionToApply)}`)
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
    if (this.argv.string) {
      const foundIssue = await this.findIssueKeyIn(this.argv.string)
      return foundIssue
    }

    await this.getJiraKeysFromGitRange()

    if (this.foundKeys.length > 0) {
      await this.transitionIssues()
      await this.updatePullRequestBody(startJiraToken, endJiraToken)
      await this.outputReleaseNotes()

      return this.foundKeys
    }

    const template = eventTemplates[this.argv.from] || this.argv._.join(' ')
    const searchStr = this.preprocessString(template)
    return this.findIssueKeyIn(searchStr)
  }

  async findIssueKeyIn(searchStr) {
    if (!searchStr) {
      core.info(`no issues found in ${this.argv.from}`)
      return
    }
    const match = searchStr.match(issueIdRegEx)

    if (!match) {
      core.info(`String "${searchStr}" does not contain issueKeys`)
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

      return tmpl({ event: this.githubEvent })
    } catch (error) {
      core.error(error)
    }
  }
}
