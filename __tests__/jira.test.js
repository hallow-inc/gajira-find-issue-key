const { describe } = require('jest-circus')
const Jira = require('../src/common/net/Jira')

const BASE_URL = process.env.JIRA_BASE_URL
const TOKEN = process.env.JIRA_TOKEN
const EMAIL = process.env.JIRA_EMAIL

describe('jira Tests', () => {
  it('jira Base Url uses HTTPS', () => {
    expect.hasAssertions()
    expect(BASE_URL).toBeTruthy()
    expect(BASE_URL.substr(0, 5)).toStrictEqual('https')
  })
})
