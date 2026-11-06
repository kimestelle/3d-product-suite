type RunState = 'submitting' | 'pending' | 'succeeded' | 'failed' | 'uncertain';
type AssetKind = 'image' | 'depth' | 'confidence';

interface AtlasRun {
  id: string;
  imageUrl: string;
  state: RunState;
  createdAt: string;
  operationId?: string;
  error?: string;
  retryAt?: string;
  result?: {camera: unknown; assets: {kind: AssetKind; url: string}[]};
}

const runLabels: Record<RunState, string> = {
  submitting: 'Submitting',
  pending: 'In progress',
  succeeded: 'Complete',
  failed: 'Failed',
  uncertain: 'Submission unconfirmed',
};

const endpoint = '/api/atlas/quickstart';

async function request<T>(path: string, body?: object): Promise<T> {
  const options: RequestInit = {credentials: 'same-origin', cache: 'no-store'};
  if (body !== undefined) {
    options.method = 'POST';
    options.headers = {'Content-Type': 'application/json', 'X-Product-Suite': '1'};
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  if (!response.headers.get('Content-Type')?.includes('application/json')) {
    throw new Error('Open World comparison from a connected Gesso workspace.');
  }
  const value = await response.json();
  if (!response.ok) {
    throw new Error(typeof value?.error === 'string' ? value.error : `Atlas request failed (${response.status}).`);
  }
  return value;
}

function runDate(value: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(time);
}

function showRun(run: AtlasRun, output: HTMLElement) {
  const heading = document.createElement('h3');
  heading.textContent = runLabels[run.state];
  output.append(heading);

  if (run.operationId) {
    const operation = document.createElement('p');
    const id = document.createElement('code');
    id.textContent = run.operationId;
    operation.append('Operation ', id);
    output.append(operation);
  }
  if (run.error) {
    const error = document.createElement('p');
    error.textContent = run.error;
    output.append(error);
  }
  if (run.state === 'uncertain' && !run.operationId) {
    const instructions = document.createElement('p');
    const operations = document.createElement('a');
    operations.href = 'https://atlas-beta.worldlabs.ai/requests';
    operations.target = '_blank';
    operations.rel = 'noopener noreferrer';
    operations.textContent = 'Open Atlas Operations ↗';
    instructions.append(operations, ' to find the original request.');
    output.append(instructions);
  }
  if (run.retryAt && Date.parse(run.retryAt) > Date.now()) {
    const retry = document.createElement('p');
    retry.textContent = `Atlas requested a delay until ${runDate(run.retryAt)}.`;
    output.append(retry);
  }
  if (run.state !== 'succeeded' || !run.result) return;

  const grid = document.createElement('div');
  grid.className = 'atlas-result-grid';
  const details = document.createElement('div');
  const downloads = document.createElement('ul');
  downloads.className = 'atlas-downloads';
  const downloadLabels: Record<AssetKind, string> = {
    image: 'Download normalized image',
    depth: 'Download linear depth EXR',
    confidence: 'Download confidence map',
  };

  for (const {kind, url} of run.result.assets) {
    const expectedUrl = `${endpoint}/${encodeURIComponent(run.id)}/assets/${kind}`;
    if (!Object.hasOwn(downloadLabels, kind) || url !== expectedUrl) continue;
    if (kind === 'image') {
      const figure = document.createElement('figure');
      const image = document.createElement('img');
      const caption = document.createElement('figcaption');
      image.alt = 'Normalized image returned by Marble 2';
      image.decoding = 'async';
      image.loading = 'lazy';
      image.addEventListener('error', () => {
        image.hidden = true;
        caption.textContent = 'Preview unavailable. Try downloading the normalized image.';
      }, {once: true});
      image.src = url;
      caption.textContent = 'Normalized image';
      figure.append(image, caption);
      grid.append(figure);
    }
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = url;
    link.download = '';
    link.textContent = downloadLabels[kind];
    item.append(link);
    downloads.append(item);
  }

  const camera = document.createElement('details');
  const summary = document.createElement('summary');
  const parameters = document.createElement('pre');
  summary.textContent = 'Estimated camera';
  parameters.textContent = JSON.stringify(run.result.camera, null, 2);
  camera.append(summary, parameters);
  details.append(downloads, camera);
  grid.append(details);
  output.append(grid);
}

function mountAtlasQuickstart(section: HTMLElement) {
  const form = section.querySelector<HTMLFormElement>('#atlas-form')!;
  const fields = section.querySelector<HTMLFieldSetElement>('#atlas-inputs')!;
  const input = section.querySelector<HTMLInputElement>('#atlas-image-url')!;
  const submit = section.querySelector<HTMLButtonElement>('#atlas-submit')!;
  const reload = section.querySelector<HTMLButtonElement>('#atlas-reload')!;
  const check = section.querySelector<HTMLButtonElement>('#atlas-check')!;
  const runLabel = section.querySelector<HTMLLabelElement>('#atlas-runs-label')!;
  const runSelect = section.querySelector<HTMLSelectElement>('#atlas-runs')!;
  const status = section.querySelector<HTMLElement>('#atlas-status')!;
  const setup = section.querySelector<HTMLElement>('#atlas-configure')!;
  const error = section.querySelector<HTMLElement>('#atlas-error')!;
  const output = section.querySelector<HTMLElement>('#atlas-result')!;

  let configured: boolean | null = null;
  let runs: AtlasRun[] = [];
  let activeId = '';
  let busy = false;
  let reloadBeforeSubmit = false;

  const activeRun = () => runs.find(run => run.id === activeId);
  const savedRun = (url: string) => runs.find(run => run.imageUrl === url && (run.state !== 'failed' || Boolean(run.operationId)));
  const pendingRun = () => runs.find(run => run.state === 'pending' || run.state === 'submitting');

  function updateControls() {
    const run = activeRun();
    fields.disabled = configured !== true || reloadBeforeSubmit;
    input.readOnly = busy;
    submit.setAttribute('aria-disabled', String(busy));
    submit.textContent = savedRun(input.value.trim()) ? 'View saved run' : pendingRun() ? 'View pending run' : 'Run Marble 2';
    check.hidden = run?.state !== 'pending' && run?.state !== 'submitting';
    check.disabled = configured !== true;
    check.setAttribute('aria-disabled', String(busy || check.disabled));
    reload.setAttribute('aria-disabled', String(busy));
    runSelect.disabled = busy;
    setup.hidden = configured !== false;
  }

  function renderRun() {
    output.replaceChildren();
    const run = activeRun();
    if (run) showRun(run, output);
    updateControls();
  }

  function renderRuns() {
    runLabel.hidden = runs.length === 0;
    if (!activeRun()) activeId = runs[0]?.id ?? '';
    runSelect.replaceChildren(...runs.map(run => {
      const option = document.createElement('option');
      option.value = run.id;
      option.textContent = [runDate(run.createdAt), runLabels[run.state]].filter(Boolean).join(' · ');
      return option;
    }));
    runSelect.value = activeId;
    renderRun();
  }

  function setError(message = '') {
    error.textContent = message;
    error.hidden = !message;
  }

  async function perform(message: string, action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    setError();
    status.textContent = message;
    updateControls();
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The Atlas request could not be read.');
    } finally {
      busy = false;
      status.textContent = configured === true ? 'Atlas connected' : configured === false ? 'Atlas API key needed' : 'Atlas connection unavailable';
      updateControls();
    }
  }

  function reloadRuns() {
    return perform('Reading saved Atlas runs…', async () => {
      const [connection, history] = await Promise.all([
        request<{configured: boolean}>('/api/atlas/status'),
        request<{runs: AtlasRun[]}>(endpoint),
      ]);
      configured = connection.configured;
      runs = history.runs;
      reloadBeforeSubmit = false;
      renderRuns();
    });
  }

  function rememberRun(run: AtlasRun) {
    const index = runs.findIndex(saved => saved.id === run.id);
    if (index === -1) runs.unshift(run);
    else runs[index] = run;
    activeId = run.id;
    renderRuns();
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (busy || configured !== true || reloadBeforeSubmit) return;
    let imageUrl: string;
    try {
      const url = new URL(input.value.trim());
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid image URL');
      imageUrl = url.href;
    } catch {
      input.setCustomValidity('Enter a public HTTPS image URL.');
      input.reportValidity();
      return;
    }
    const existing = savedRun(imageUrl) ?? pendingRun();
    if (existing) {
      activeId = existing.id;
      runSelect.value = activeId;
      renderRun();
      return;
    }
    void perform('Submitting to Marble 2…', async () => {
      try {
        rememberRun(await request<AtlasRun>(endpoint, {imageUrl}));
      } catch (reason) {
        reloadBeforeSubmit = true;
        const message = reason instanceof Error ? reason.message : 'Submission could not be confirmed.';
        throw new Error(`${message} Reload runs before submitting again.`);
      }
    });
  });

  input.addEventListener('input', () => {
    input.setCustomValidity('');
    updateControls();
  });
  runSelect.addEventListener('change', () => {
    activeId = runSelect.value;
    setError();
    renderRun();
  });
  reload.addEventListener('click', () => {void reloadRuns();});
  check.addEventListener('click', () => {
    const run = activeRun();
    if (configured !== true || (run?.state !== 'pending' && run?.state !== 'submitting')) return;
    if (run.retryAt && Date.parse(run.retryAt) > Date.now()) {
      setError(`Try again after ${runDate(run.retryAt)}.`);
      return;
    }
    void perform('Checking Marble 2 operation…', async () => {
      const updated = await request<AtlasRun>(`${endpoint}/${encodeURIComponent(run.id)}/refresh`, {});
      const returnFocus = document.activeElement === check;
      rememberRun(updated);
      if (returnFocus && check.hidden) {
        const heading = output.querySelector('h3');
        if (heading) {
          heading.tabIndex = -1;
          heading.focus({preventScroll: true});
        }
      }
    });
  });

  void reloadRuns();
}

const section = document.getElementById('marble-2');
if (section) mountAtlasQuickstart(section);
