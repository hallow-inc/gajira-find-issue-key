const { describe } = require('jest-circus')
const Jira = require('../src/common/net/Jira')

const BASE_URL = process.env.JIRA_BASE_URL
const TOKEN = process.env.JIRA_TOKEN
const EMAIL = process.env.JIRA_EMAIL

describe('jira Tests', () => {
  it('adds 1 + 2 to equal 3', () => {
    expect.hasAssertions()
    expect(BASE_URL).toStartWith('https')
  })
})
