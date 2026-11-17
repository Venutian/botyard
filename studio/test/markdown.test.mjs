// What a bot writes in a chat is shown formatted, and can never become markup of its own.

import test from 'node:test'
import assert from 'node:assert/strict'
import { markdown } from '../src/ui/markdown.js'

test('a reply is shown with its headings, lists, code and emphasis', () => {
  assert.equal(markdown('## Done\n\nTwo things:\n- **one**\n- `two`\n\n1. first\n2) second'),
    '<h4 class="big">Done</h4><p>Two things:</p><ul><li><strong>one</strong></li><li><code>two</code></li></ul><ol><li>first</li><li>second</li></ol>')
  assert.equal(markdown('a\nb\n\n> said\n> twice'), '<p>a<br>b</p><blockquote><p>said<br>twice</p></blockquote>')
  assert.equal(markdown('```js\nconst a = 1 < 2\n```'), '<pre><code>const a = 1 &lt; 2</code></pre>')
  assert.equal(markdown('it is *fine* and snake_case_name stays, 2 * 3 * 4 too'), '<p>it is <em>fine</em> and snake_case_name stays, 2 * 3 * 4 too</p>')
})

test('tables, nested and ticked lists, struck text and bare links are shown as written', () => {
  assert.equal(markdown('| Number | State |\n|---|:-:|\n| Rows | **NOT MET** |'),
    '<div class="table"><table><thead><tr><th>Number</th><th style="text-align:center">State</th></tr></thead><tbody><tr><td>Rows</td><td style="text-align:center"><strong>NOT MET</strong></td></tr></tbody></table></div>')
  assert.equal(markdown('1. a\n   - b\n2. c\n\n4. d'), '<ol><li>a<ul><li>b</li></ul></li><li>c</li></ol><ol start="4"><li>d</li></ol>')
  assert.equal(markdown('- [x] done\n- [ ] not'), '<ul><li class="task"><input type="checkbox" disabled checked> done</li><li class="task"><input type="checkbox" disabled> not</li></ul>')
  assert.equal(markdown('~~old~~ see https://example.org/a.'), '<p><del>old</del> see <a href="https://example.org/a" target="_blank" rel="noopener noreferrer">https://example.org/a</a>.</p>')
  assert.equal(markdown('| a |\n|---|\n| <b>x</b> |'), '<div class="table"><table><thead><tr><th>a</th></tr></thead><tbody><tr><td>&lt;b&gt;x&lt;/b&gt;</td></tr></tbody></table></div>')
})

test('nothing a bot writes becomes a tag or a script', () => {
  assert.equal(markdown('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>')
  assert.equal(markdown('[x](javascript:alert(1))'), '<p>[x](javascript:alert(1))</p>')
  assert.equal(markdown('[site](https://example.com/a?b=1)'), '<p><a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer">site</a></p>')
  assert.equal(markdown('`**not bold** <b>`'), '<p><code>**not bold** &lt;b&gt;</code></p>')
  assert.equal(markdown('[LH-1](/YRD/issues/LH-1)', { base: 'http://127.0.0.1:3100' }), '<p><a href="http://127.0.0.1:3100/YRD/issues/LH-1" target="_blank" rel="noopener noreferrer">LH-1</a></p>')
  assert.equal(markdown('[x](//evil.example/a)', { base: 'http://127.0.0.1:3100' }), '<p>[x](//evil.example/a)</p>')
  assert.equal(markdown(null), '')
})

test("on the map a link to a job's board page opens the job's own page, and other board pages are only words", () => {
  assert.equal(markdown('See [LH-12](/YRD/issues/LH-12#comment-1).', { jobs: true }), '<p>See <button class="link" data-act="open-job" data-id="LH-12">LH-12</button>.</p>')
  assert.equal(markdown('[the board](/YRD/dashboard) and [x](//evil.example/a)', { jobs: true }), '<p>the board and [x](//evil.example/a)</p>')
  assert.equal(markdown('[a](/YRD/issues/LH-1"onclick=x)', { jobs: true }), '<p>a</p>')
})
