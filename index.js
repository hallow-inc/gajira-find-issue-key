const fs = require('fs')
const YAML = require('yaml')
const core = require('@actions/core')

const cliConfigPath = `${process.env.HOME}/.jira.d/config.yml`
const configPath = `${process.env.HOME}/jira/config.yml`

core.debug('Requiring Action')
const Action = require('./action')

core.debug('Requiring Github Event Path')
const githubEvent = process.env.GITHUB_EVENT_PATH ? require(process.env.GITHUB_EVENT_PATH) : []
const config = YAML.parse(fs.readFileSync(configPath, 'utf8'))

async function writeKey(result) {
  if (!result) {
    return
  }
  core.debug(`Detected issueKey: ${result.get('key')}`)
  core.debug(`Saving ${result.get('key')} to ${cliConfigPath}`)
  core.debug(`Saving ${result.get('key')} to ${configPath}`)

  // Expose created issue's key as an output

  const yamledResult = YAML.stringify(result)
  const extendedConfig = { ...config, ...result }

  fs.writeFileSync(configPath, YAML.stringify(extendedConfig))

  return fs.appendFileSync(cliConfigPath, yamledResult)
}

async function exec() {
  try {
    const result = await new Action({
      githubEvent,
      argv: parseArgs(),
      config,
    }).execute()

    if (result) {
      core.debug(`Result was returned.`)
      if (Array.isArray(result)) {
        core.debug('Result is an array')
        const outputIssues = []

        for (const item of result) {
          await writeKey(item)
          outputIssues.push(item.get('key'))
        }

        core.setOutput('issues', outputIssues.join(','))

        return
      }
      core.debug('Result is not an array')
      core.setOutput('issue', result.get('key'))

      return await writeKey(result)
    }

    core.debug('No issueKeys found.')
    core.setNeutral()
  } catch (error) {
    core.setFailed(error.toString())
  }
}

function parseArgs() {
  const fromList = ['commits', 'pull_request', 'branch']

  return {
    string: core.getInput('string') || config.string,
    from: fromList.includes(core.getInput('from')) ? core.getInput('from') : 'commits',
    githubToken: core.getInput('github-token'),
    headRef: core.getInput('head-ref'),
    baseRef: core.getInput('base-ref'),
    includeMergeMessages: core.getInput('include-merge-messages') === 'true',
    GitHubIssues: core.getInput('generate-github-issues') === 'true',
    GitHubMilestones: core.getInput('generate-github-milestones') === 'true',
    returns: core.getInput('returns') || 'first',
    updatePRTitle: core.getInput('standardize-pr-title') === 'true',
    transitionChain: core.getInput('jira-transition-chain'),
    transitionOnNewBranch: core.getInput('jira-transition-on-new-branch'),
    transitionOnPrOpen: core.getInput('jira-transition-on-pr-open'),
    transitionOnPrApproval: core.getInput('jira-transition-on-pr-approval'),
    transitionOnPrMerge: core.getInput('jira-transition-on-pr-merge'),
  }
}

exec()
