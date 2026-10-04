import { createServer } from 'node:http';

/**
 * A generic local page for automated tests and the UI harness. It is not a
 * copy of any real website and says so on every page.
 */

const BANNER = '<p class="banner">DEV TEST PAGE — NOT CAST, NOT SINGTEL</p>';
const STYLE = `<style>
  body { margin: 0; font: 18px -apple-system, system-ui, sans-serif; color: #2c3138; background: #f3f4f6; }
  .banner { margin: 0; padding: 14px; background: #ffd35c; color: #3a2a00; font-weight: 700; text-align: center; }
  main { padding: 28px 40px; }
  a, button, input { font: inherit; }
  button, input { padding: 10px 14px; margin: 6px 0; }
  .row { margin: 14px 0; }
  #overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.2); }
</style>`;

const HOME = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Dev test page</title>${STYLE}</head><body>
${BANNER}
<main>
  <h1>Dev test page</h1>
  <div class="row"><a id="to-form" href="/form">Open the dev test form</a></div>
  <div class="row"><a id="new-tab" href="/form" target="_blank">Open the dev test form in a new tab</a></div>
  <div class="row"><button id="counter" type="button">Count: 0</button></div>
  <div class="row"><label for="field-a">Field A</label><br><input id="field-a" name="fieldA"></div>
  <div class="row"><label for="secret">Secret field</label><br><input id="secret" type="password"></div>
  <div style="height: 2400px"></div>
  <p id="bottom">Bottom marker</p>
</main>
<script>
  const counter = document.getElementById('counter');
  let count = 0;
  counter.addEventListener('click', () => { counter.textContent = 'Count: ' + (count += 1); });
</script>
</body></html>`;

// ?cover=1 puts an overlay over the page once the code field has text, so the
// submit click cannot complete. ?echo=1 repeats the entered code on the page.
const FORM = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Dev test form</title>${STYLE}</head><body>
${BANNER}
<main>
  <h1>Dev test form</h1>
  <p id="account">Signed in as dev test account</p>
  <div class="row"><label for="code">Test code</label><br><input id="code" name="code" autocomplete="off"></div>
  <div class="row"><button id="submit" type="button">Submit test code</button></div>
  <p id="submissions">Submissions: 0</p>
  <p id="result"></p>
  <div class="row"><a href="/">Back to the dev test page</a></div>
</main>
<script>
  const query = new URLSearchParams(location.search);
  const code = document.getElementById('code');
  let submissions = 0;
  code.addEventListener('input', () => {
    if (query.has('cover') && code.value && !document.getElementById('overlay')) {
      const overlay = document.createElement('div');
      overlay.id = 'overlay';
      document.body.append(overlay);
    }
  });
  document.getElementById('submit').addEventListener('click', () => {
    submissions += 1;
    document.getElementById('submissions').textContent = 'Submissions: ' + submissions;
    const outcome = code.value === 'FIXTURE-CONFIRM' ? 'accepted' : code.value === 'FIXTURE-REJECT' ? 'rejected' : 'unclear';
    document.getElementById('result').textContent =
      'DEV RESULT: ' + outcome + (query.has('echo') ? ' for ' + code.value : '');
  });
</script>
</body></html>`;

export async function startDevSite({ port = 0 } = {}) {
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://dev').pathname;
    // /slow is the home page after a delay, for tests of work in flight.
    const body = path === '/' || path === '/slow' ? HOME : path === '/form' ? FORM : null;
    setTimeout(() => {
      response.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(body ?? 'Not found');
    }, path === '/slow' ? 500 : 0);
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    host: `127.0.0.1:${server.address().port}`,
    home: `${origin}/`,
    form: `${origin}/form`,
    close() {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
