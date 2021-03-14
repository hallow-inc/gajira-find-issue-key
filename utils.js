const github = require('@actions/github')
export const { context } = github
export async function getPreviousReleaseRef(octo) {
    if (!context.repository || !octo) {
      return
    }
    const releases = await octo.repos.getLatestRelease({
      ...context.repo,
    })
  
    const { tag_name } = releases.payload
  
    return tag_name
  }
  
export function upperCaseFirst(str) {
    return str.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substr(1))
  }

export const issueIdRegEx = /([a-zA-Z0-9]+-[0-9]+)/g

export const startJiraToken = 'JIRA-ISSUE-TEXT-START'
export const endJiraToken = 'JIRA-ISSUE-TEXT-END'

export const eventTemplates = {
  branch: '{{event.ref}}',
  commits: "{{event.commits.map(c=>c.message).join(' ')}}",
}