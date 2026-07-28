/* eslint-disable camelcase */

const core = require('@actions/core')

module.exports = class {
  /**
 * Takes Jira markup and converts it to Markdown.
 *
 * @param {string} input - Jira markup text
 * @returns {string} - Markdown formatted text
 */
  toM (inputText) {
    // Protect {code} and {noformat} blocks BEFORE any inline markup runs.
    // Previously the inline substitutions below (bold, `??` -> cite, links,
    // etc.) ran directly over raw code content and corrupted it. Extracting the
    // blocks to placeholders first keeps their contents verbatim and, crucially,
    // keeps source code (e.g. Swift's `??` nil-coalescing operator) away from
    // the cite regex. The blocks are restored at the very end.
    const START = 'J2MBLOCKPLACEHOLDER'
    const replacementsList = []
    let counter = 0

    const protectBlock = (value) => {
      const key = `${START + counter++}%%`

      replacementsList.push({ key, value })

      return key
    }

    // Lazy `[^]*?` so each code block is captured individually (greedy `[^]*`
    // used to merge everything between the first and last {code} marker).
    let input = inputText.replace(
      /\{code(:([a-z]+))?\}([^]*?)\{code\}/g,
      (match, langGroup, lang, content) => protectBlock(`\`\`\`${lang || ''}${content}\`\`\``),
    )

    input = input.replace(/\{noformat\}([^]*?)\{noformat\}/g, (match, content) => protectBlock(`\`\`\`${content}\`\`\``))

    input = input.replace(/^h([0-6])\.(.*)$/gm, (match, level, content) => Array(parseInt(level, 10) + 1).join('#') + content)

    input = input.replace(/([*_])(.*)\1/g, (match, wrapper, content) => {
      const to = (wrapper === '*') ? '**' : '*'

      return to + content + to
    })

    input = input.replace(/\{\{([^}]+)\}\}/g, '`$1`')
    // Lazy, non-overlapping match. The previous `((?:.[^?]|[^?].)+)` was an
    // ambiguous overlapping alternation under `+` and caused catastrophic
    // backtracking (ReDoS) on any text containing `??` without a clean closing
    // pair (e.g. Swift `??` operators), hanging the whole action.
    input = input.replace(/\?\?([\s\S]+?)\?\?/g, '<cite>$1</cite>')
    input = input.replace(/\+([^+]*)\+/g, '<ins>$1</ins>')
    input = input.replace(/\^([^^]*)\^/g, '<sup>$1</sup>')
    input = input.replace(/~([^~]*)~/g, '<sub>$1</sub>')
    input = input.replace(/-([^-]*)-/g, '-$1-')

    input = input.replace(/\[(.+?)\|(.+)\]/g, '[$1]($2)')
    input = input.replace(/\[(.+?)\]([^(]*)/g, '<$1>$2')

    // Any unpaired {noformat} marker left over (backwards compatible with the
    // previous per-marker replacement).
    input = input.replace(/\{noformat\}/g, '```')

    // Convert header rows of tables by splitting input on lines
    const lines = input.split(/\r?\n/gm)

    for (let i = 0; i < lines.length; i++) {
      // eslint-disable-next-line camelcase
      const line_content = lines[i]

      const separators = line_content.match(/\|\|/g)

      if (separators != null) {
        lines[i] = lines[i].replace(/\|\|/g, '|')
        core.debug(separators)

        // Add a new line to mark the header in Markdown,
        // we require that at least 3 -'s are between each |
        let header_line = ''

        for (let j = 0; j < separators.length - 1; j++) {
          header_line += '|---'
        }

        header_line += '|'

        lines.splice(i + 1, 0, header_line)
      }
    }

    // Join the split lines back
    input = ''
    for (let i = 0; i < lines.length; i++) {
      input += `${lines[i]}\n`
    }

    // Restore the protected code/noformat blocks now that inline and table
    // processing is done. A function replacer is used so that `$` inside the
    // code content is treated literally rather than as a replacement pattern.
    for (let i = 0; i < replacementsList.length; i++) {
      const sub = replacementsList[i]

      input = input.replace(sub.key, () => sub.value)
    }

    return input
  }

  /**
       * Takes Markdown and converts it to Jira formatted text
       *
       * @param {string} input
       * @returns {string}
       */
  toJ (inputText) {
    // remove sections that shouldn't be recursively processed
    const START = 'J2MBLOCKPLACEHOLDER'
    const replacementsList = []
    let counter = 0

    let input = inputText.replace(/`{3,}(\w+)?((?:\n|.)+?)`{3,}/g, (match, synt, content) => {
      let code = '{code'

      if (synt) {
        code += `:${synt}`
      }

      code += `}${content}{code}`
      const key = `${START + counter++}%%`

      replacementsList.push({ key, value: code })

      return key
    })

    input = input.replace(/`([^`]+)`/g, (match, content) => {
      const code = `{{${content}}}`
      const key = `${START + counter++}%%`

      replacementsList.push({ key, value: code })

      return key
    })

    input = input.replace(/`([^`]+)`/g, '{{$1}}')

    input = input.replace(/^(.*?)\n([=-])+$/gm, (match, content, level) => `h${level[0] === '=' ? 1 : 2}. ${content}`)

    input = input.replace(/^([#]+)(.*?)$/gm, (match, level, content) => `h${level.length}.${content}`)

    input = input.replace(/([*_]+)(.*?)\1/g, (match, wrapper, content) => {
      const to = (wrapper.length === 1) ? '_' : '*'

      return to + content + to
    })
    // Make multi-level bulleted lists work
    input = input.replace(/^(\s*)- (.*)$/gm, (match, level, content) => {
      let len = 2

      if (level.length > 0) {
        len = parseInt(level.length / 4.0, 10) + 2
      }

      return `${Array(len).join('-')} ${content}`
    })

    const map = {
      cite: '??',
      del: '-',
      ins: '+',
      sup: '^',
      sub: '~',
    }

    input = input.replace(new RegExp(`<(${Object.keys(map).join('|')})>(.*?)</\\1>`, 'g'), (match, from, content) => {
      // core.debug(from);
      const to = map[from]

      return to + content + to
    })

    input = input.replace(/~~(.*?)~~/g, '-$1-')

    input = input.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '[$1|$2]')
    input = input.replace(/<([^>]+)>/g, '[$1]')

    // restore extracted sections
    for (let i = 0; i < replacementsList.length; i++) {
      const sub = replacementsList[i]

      input = input.replace(sub.key, sub.value)
    }

    // Convert header rows of tables by splitting input on lines
    const lines = input.split(/\r?\n/gm)

    for (let i = 0; i < lines.length; i++) {
      const line_content = lines[i]

      if (line_content.match(/\|---/g) != null) {
        lines[i - 1] = lines[i - 1].replace(/\|/g, '||')
        lines.splice(i, 1)
      }
    }

    // Join the split lines back
    input = ''
    for (let i = 0; i < lines.length; i++) {
      input += `${lines[i]}\n`
    }

    return input
  }
}
