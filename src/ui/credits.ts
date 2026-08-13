import { requiresAttribution, type AssetManifest, type AssetLicense } from '../shared/manifest.js';

/**
 * Third-party code shipped in the bundle.
 *
 * Hardcoded rather than derived from `package.json`: only the handful of
 * libraries that actually reach the browser belong here, and their licences
 * change about as often as the dependencies themselves. Keep it honest — if
 * you add a runtime dependency, add it here too.
 */
const RUNTIME_CREDITS: ReadonlyArray<{ name: string; license: string; url: string }> = [
  { name: 'Babylon.js', license: 'Apache-2.0', url: 'https://www.babylonjs.com/' },
  { name: 'Trystero', license: 'MIT', url: 'https://github.com/dmotz/trystero' },
];

/**
 * The in-game credits panel.
 *
 * This is a licence obligation, not a nicety. Anything under an attribution
 * licence (CC-BY and friends) has to be credited *in the running game* —
 * a file sitting in the deployment is not generally sufficient. `ATTRIBUTION.md`
 * covers the repository; this covers the player.
 *
 * Built on a native `<dialog>` so focus trapping, Escape-to-close and the
 * backdrop come from the platform rather than from hand-rolled JavaScript.
 */
export class Credits {
  readonly button: HTMLButtonElement;
  readonly dialog: HTMLDialogElement;

  #onKeyGuard = (event: KeyboardEvent): void => {
    // The game reads raw key state; stop movement keys leaking through while
    // the panel is open and the player is reading.
    event.stopPropagation();
  };

  constructor(parent: HTMLElement, manifest: AssetManifest) {
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'credits__open';
    this.button.textContent = 'Credits';
    this.button.dataset['testid'] = 'credits-button';
    this.button.setAttribute('aria-label', 'Show credits and asset licences');

    this.dialog = document.createElement('dialog');
    this.dialog.className = 'credits';
    this.dialog.dataset['testid'] = 'credits-dialog';
    this.dialog.append(this.#buildContent(manifest));

    this.button.addEventListener('click', () => this.dialog.showModal());
    this.dialog.addEventListener('keydown', this.#onKeyGuard);
    // Clicking the backdrop lands on the dialog element itself.
    this.dialog.addEventListener('click', (event) => {
      if (event.target === this.dialog) this.dialog.close();
    });

    parent.append(this.button, this.dialog);
  }

  dispose(): void {
    this.dialog.removeEventListener('keydown', this.#onKeyGuard);
    this.button.remove();
    this.dialog.remove();
  }

  // -------------------------------------------------------------- internals

  #buildContent(manifest: AssetManifest): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'credits__body';

    const heading = document.createElement('h2');
    heading.className = 'credits__title';
    heading.textContent = 'Credits';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'credits__close';
    close.textContent = 'Close';
    close.dataset['testid'] = 'credits-close';
    close.addEventListener('click', () => this.dialog.close());

    const header = document.createElement('div');
    header.className = 'credits__header';
    header.append(heading, close);

    wrapper.append(header, this.#buildAssets(manifest), this.#buildRuntime());
    return wrapper;
  }

  #buildAssets(manifest: AssetManifest): HTMLElement {
    const section = document.createElement('section');
    section.className = 'credits__section';

    const title = document.createElement('h3');
    title.className = 'credits__subtitle';
    title.textContent = 'Art';
    section.append(title);

    if (manifest.models.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'credits__note';
      empty.textContent = 'All geometry in this build is generated procedurally.';
      section.append(empty);
      return section;
    }

    const list = document.createElement('ul');
    list.className = 'credits__list';

    for (const model of [...manifest.models].sort((a, b) => a.id.localeCompare(b.id))) {
      const item = document.createElement('li');
      item.className = 'credits__entry';
      item.dataset['testid'] = 'credits-entry';
      item.dataset['assetId'] = model.id;

      const name = document.createElement('span');
      name.className = 'credits__name';
      name.textContent = model.description ?? model.id;

      const meta = document.createElement('span');
      meta.className = 'credits__meta';
      meta.append(this.#licenseLine(model.license));

      // Flagged so it is obvious at a glance which entries are here because
      // the licence demands it rather than out of courtesy.
      if (requiresAttribution(model.license)) {
        item.classList.add('is-required');
        meta.prepend(document.createTextNode('★ '));
      }

      item.append(name, meta);
      list.append(item);
    }

    section.append(list);
    return section;
  }

  #licenseLine(license: AssetLicense | undefined): DocumentFragment {
    const fragment = document.createDocumentFragment();
    if (!license) {
      fragment.append('licence unknown');
      return fragment;
    }

    const author = license.author ? `${license.author} — ` : '';
    fragment.append(`${author}${license.name} — `);

    if (/^https?:\/\//.test(license.source)) {
      const link = document.createElement('a');
      link.href = license.source;
      link.textContent = 'source';
      link.rel = 'noopener noreferrer';
      link.target = '_blank';
      fragment.append(link);
    } else {
      fragment.append(license.source);
    }

    return fragment;
  }

  #buildRuntime(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'credits__section';

    const title = document.createElement('h3');
    title.className = 'credits__subtitle';
    title.textContent = 'Built with';
    section.append(title);

    const list = document.createElement('ul');
    list.className = 'credits__list';

    for (const dependency of RUNTIME_CREDITS) {
      const item = document.createElement('li');
      item.className = 'credits__entry';

      const name = document.createElement('span');
      name.className = 'credits__name';
      const link = document.createElement('a');
      link.href = dependency.url;
      link.textContent = dependency.name;
      link.rel = 'noopener noreferrer';
      link.target = '_blank';
      name.append(link);

      const meta = document.createElement('span');
      meta.className = 'credits__meta';
      meta.textContent = dependency.license;

      item.append(name, meta);
      list.append(item);
    }

    section.append(list);
    return section;
  }
}
