const DEFAULT_SETTINGS = {
  publishByDefault: true,
  sites: []
};

const MENU_LABEL = 'Halo 发布';

const state = {
  context: null,
  settings: null,
  disposeMenu: null
};

export async function activate(context) {
  state.context = context;
  state.settings = await loadSettings(context);

  const hasDefault = Boolean(state.settings.sites.find((site) => site.default));

  state.disposeMenu = context.addMenuItem({
    label: MENU_LABEL,
    title: '发布或更新文章到 Halo',
    children: [
      {
        label: '发布到 Halo',
        note: '选择站点后发布当前文档',
        onClick: () => runSafe(() => publishCommand(context, { askUser: true }))
      },
      {
        label: '默认站点快速发布',
        note: hasDefault ? '使用设置中的默认站点' : '请先设置默认站点',
        disabled: !hasDefault,
        onClick: () => runSafe(() => publishCommand(context, { useDefault: true }))
      },
      {
        label: '更新当前文档',
        note: '从 Halo 拉取当前文章内容',
        onClick: () => runSafe(() => updateCommand(context))
      },
      { type: 'divider' },
      {
        label: '配置站点',
        onClick: () => runSafe(() => openSettings(context))
      }
    ]
  });

  safeNotice(context, 'Halo 发布插件已加载', 'ok', 1600);
}

export function deactivate() {
  if (state.disposeMenu) {
    try {
      state.disposeMenu();
    } catch (error) {
      console.warn('[flymd-halo] 移除菜单失败', error);
    }
    state.disposeMenu = null;
  }
}

export async function openSettings(context) {
  const current = await loadSettings(context);
  const updated = await showSettingsModal(current);
  if (!updated) {
    return;
  }
  state.settings = updated;
  await saveSettings(context, state.settings);
  safeNotice(context, 'Halo 配置已更新', 'ok');
}

async function publishCommand(context, options = {}) {
  const settings = await ensureSettings(context);
  if (!settings.sites.length) {
    safeNotice(context, '请先在设置中添加 Halo 站点', 'err');
    return;
  }

  const doc = readCurrentDocument(context);
  if (!doc.body.trim()) {
    safeNotice(context, '当前文档为空，无法发布', 'err');
    return;
  }

  const haloMeta = getHaloMeta(doc.frontmatter);

  let targetSite = null;

  if (options.useDefault) {
    targetSite = settings.sites.find((site) => site.default);
    if (!targetSite) {
      safeNotice(context, '未设置默认站点', 'err');
      return;
    }
  } else if (haloMeta.site) {
    targetSite = settings.sites.find((site) => site.url === haloMeta.site);
    if (!targetSite) {
      safeNotice(context, 'Front Matter 中的 Halo 站点在配置中不存在', 'err');
      return;
    }
  } else if (settings.sites.length === 1) {
    targetSite = settings.sites[0];
  } else if (options.askUser) {
    targetSite = await promptSiteSelection(settings, '请选择要发布到的 Halo 站点:');
  } else {
    targetSite = settings.sites.find((site) => site.default) || settings.sites[0];
  }

  if (!targetSite) {
    safeNotice(context, '已取消发布', 'err');
    return;
  }

  await publishToHalo(context, targetSite, doc, settings);
}

async function updateCommand(context) {
  const settings = await ensureSettings(context);
  if (!settings.sites.length) {
    safeNotice(context, '请先在设置中添加 Halo 站点', 'err');
    return;
  }

  const doc = readCurrentDocument(context);
  const haloMeta = getHaloMeta(doc.frontmatter);

  if (!haloMeta.name || !haloMeta.site) {
    safeNotice(context, '当前文档尚未发布到 Halo', 'err');
    return;
  }

  const targetSite = settings.sites.find((site) => site.url === haloMeta.site);

  if (!targetSite) {
    safeNotice(context, 'Front Matter 中的 Halo 站点在配置中不存在', 'err');
    return;
  }

  await pullFromHalo(context, targetSite, doc);
}

async function publishToHalo(context, site, doc, settings) {
  const haloMeta = getHaloMeta(doc.frontmatter);

  if (haloMeta.site && haloMeta.site !== site.url) {
    safeNotice(context, 'Front Matter 中的站点与当前选择的站点不一致', 'err');
    return;
  }

  const client = createHaloClient(context, site);

  let post = createEmptyPost();
  let content = createEmptyContent();

  if (haloMeta.name) {
    const existing = await client.getPost(haloMeta.name);
    if (existing) {
      post = existing.post;
      content = existing.content;
    }
  }

  content.raw = doc.body;
  content.rawType = 'markdown';
  content.content = await renderMarkdown(doc.body);

  applyFrontMatterToPost(doc.frontmatter, post);

  const categories = normalizeStringArray(doc.frontmatter.categories);
  const tags = normalizeStringArray(doc.frontmatter.tags);

  if (categories.length) {
    post.spec.categories = await client.ensureCategoryNames(categories);
  } else {
    post.spec.categories = [];
  }
  if (tags.length) {
    post.spec.tags = await client.ensureTagNames(tags);
  } else {
    post.spec.tags = [];
  }

  try {
    if (post.metadata.name) {
      await client.updatePost(post, content);
    } else {
      post = await client.createPost(post, content, doc);
    }
  } catch (error) {
    console.error('[flymd-halo] 发布失败', error);
    safeNotice(context, '发布失败，请查看日志', 'err', 3000);
    return;
  }

  try {
    const publishFlag = typeof haloMeta.publish === 'boolean' ? haloMeta.publish : settings.publishByDefault;
    if (publishFlag) {
      await client.changePostPublish(post.metadata.name, true);
    } else if (post.spec.publish) {
      await client.changePostPublish(post.metadata.name, false);
    }
  } catch (error) {
    console.warn('[flymd-halo] 更改发布状态失败', error);
  }

  try {
    const freshest = await client.getPost(post.metadata.name);
    if (freshest) {
      post = freshest.post;
      content = freshest.content;
    }
  } catch (error) {
    console.warn('[flymd-halo] 刷新文章信息失败', error);
  }

  const postCategories = await client.getCategoryDisplayNames(post.spec.categories);
  const postTags = await client.getTagDisplayNames(post.spec.tags);

  const updatedFrontmatter = { ...doc.frontmatter };
  updatedFrontmatter.title = post.spec.title;
  updatedFrontmatter.slug = post.spec.slug;
  updatedFrontmatter.cover = post.spec.cover || undefined;
  updatedFrontmatter.excerpt = post.spec.excerpt?.autoGenerate ? undefined : post.spec.excerpt?.raw;
  updatedFrontmatter.categories = postCategories.length ? postCategories : undefined;
  updatedFrontmatter.tags = postTags.length ? postTags : undefined;
  updatedFrontmatter.halo = {
    site: site.url,
    name: post.metadata.name,
    publish: Boolean(post.spec.publish)
  };

  const newDoc = buildDocument(updatedFrontmatter, doc.body);
  context.setEditorValue(newDoc);
  safeNotice(context, '发布成功', 'ok');
}

async function pullFromHalo(context, site, doc) {
  const haloMeta = getHaloMeta(doc.frontmatter);
  const client = createHaloClient(context, site);

  const existing = await client.getPost(haloMeta.name);

  if (!existing) {
    safeNotice(context, 'Halo 上未找到对应文章', 'err');
    return;
  }

  const postCategories = await client.getCategoryDisplayNames(existing.post.spec.categories);
  const postTags = await client.getTagDisplayNames(existing.post.spec.tags);

  const updatedFrontmatter = { ...doc.frontmatter };
  updatedFrontmatter.title = existing.post.spec.title;
  updatedFrontmatter.slug = existing.post.spec.slug;
  updatedFrontmatter.cover = existing.post.spec.cover || undefined;
  updatedFrontmatter.excerpt = existing.post.spec.excerpt?.autoGenerate ? undefined : existing.post.spec.excerpt?.raw;
  updatedFrontmatter.categories = postCategories.length ? postCategories : undefined;
  updatedFrontmatter.tags = postTags.length ? postTags : undefined;
  updatedFrontmatter.halo = {
    site: site.url,
    name: existing.post.metadata.name,
    publish: Boolean(existing.post.spec.publish)
  };

  const body = existing.content.raw || doc.body;
  const newDoc = buildDocument(updatedFrontmatter, body);

  context.setEditorValue(newDoc);
  safeNotice(context, '已更新为 Halo 中的内容', 'ok');
}

function readCurrentDocument(context) {
  const raw = context.getEditorValue() || '';
  const normalized = raw.replace(/\r\n/g, '\n');
  const parsed = parseDocument(normalized);
  return parsed;
}

function getHaloMeta(frontmatter) {
  const halo = frontmatter?.halo || {};
  return {
    site: typeof halo.site === 'string' ? halo.site.trim() : '',
    name: typeof halo.name === 'string' ? halo.name.trim() : '',
    publish: typeof halo.publish === 'boolean' ? halo.publish : undefined
  };
}

async function ensureSettings(context) {
  if (!state.settings) {
    state.settings = await loadSettings(context);
  }
  return state.settings;
}

async function loadSettings(context) {
  try {
    const saved = await context.storage.get('settings');
    if (saved && typeof saved === 'object') {
      const normalized = {
        publishByDefault: typeof saved.publishByDefault === 'boolean' ? saved.publishByDefault : DEFAULT_SETTINGS.publishByDefault,
        sites: Array.isArray(saved.sites) ? saved.sites.map(normalizeSite).filter(Boolean) : []
      };
      return normalized;
    }
  } catch (error) {
    console.warn('[flymd-halo] 加载设置失败', error);
  }
  return { ...DEFAULT_SETTINGS, sites: [] };
}

async function saveSettings(context, settings) {
  try {
    await context.storage.set('settings', settings);
  } catch (error) {
    console.warn('[flymd-halo] 保存设置失败', error);
  }
}

function normalizeSite(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = normalizeSiteUrl(raw.url || raw.baseUrl || '');
  const token = typeof raw.token === 'string' ? raw.token.trim() : '';
  if (!url || !token) return null;
  return {
    id: raw.id || randomUUID(),
    name: typeof raw.name === 'string' ? raw.name.trim() : '',
    url,
    token,
    default: Boolean(raw.default)
  };
}


async function promptSiteSelection(settings, message) {
  const list = settings.sites.map((site, index) => `${index + 1}. ${site.name || site.url}${site.default ? '（默认）' : ''}`).join('\n');
  const answer = prompt(`${message}\n\n${list}`, '1');
  if (answer === null) return null;
  const idx = Number(answer) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx >= settings.sites.length) {
    alert('无效的编号');
    return null;
  }
  return settings.sites[idx];
}

function normalizeSiteUrl(input) {
  if (!input || typeof input !== 'string') return '';
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  url = url.replace(/\/+$/, '');
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

async function showSettingsModal(settings) {
  if (typeof document === 'undefined') {
    alert('当前环境不支持图形化配置，请在桌面应用中使用该功能。');
    return null;
  }

  return await new Promise((resolve) => {
    ensureSettingsStyles();
    const working = {
      publishByDefault: !!settings.publishByDefault,
      sites: Array.isArray(settings.sites)
        ? settings.sites.map((site) => ({
            id: site.id || randomUUID(),
            name: site.name || '',
            url: site.url || '',
            token: site.token || '',
            default: Boolean(site.default)
          }))
        : []
    };

    if (!working.sites.length) {
      working.sites.push({
        id: randomUUID(),
        name: '',
        url: '',
        token: '',
        default: true
      });
    } else if (!working.sites.some((site) => site.default)) {
      working.sites[0].default = true;
    }

    let workingSites = working.sites;

    const overlay = document.createElement('div');
    overlay.className = 'flymd-halo-settings-overlay';

    const panel = document.createElement('div');
    panel.className = 'flymd-halo-settings-panel';
    overlay.appendChild(panel);

    const header = document.createElement('div');
    header.className = 'halo-settings-header';
    const title = document.createElement('h2');
    title.textContent = 'Halo 站点配置';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'halo-close-btn';
    closeBtn.textContent = 'X';
    header.appendChild(title);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const hint = document.createElement('p');
    hint.className = 'halo-settings-hint';
    hint.textContent = '为 Flymd 配置可用的 Halo 站点与 Personal Access Token，可设置默认的发布目标。';
    panel.appendChild(hint);

    const publishRow = document.createElement('label');
    publishRow.className = 'halo-toggle';
    const publishCheckbox = document.createElement('input');
    publishCheckbox.type = 'checkbox';
    publishCheckbox.checked = working.publishByDefault;
    publishCheckbox.addEventListener('change', () => {
      working.publishByDefault = publishCheckbox.checked;
    });
    const publishText = document.createElement('span');
    publishText.textContent = '发布后默认设置为“已发布”状态';
    publishRow.appendChild(publishCheckbox);
    publishRow.appendChild(publishText);
    panel.appendChild(publishRow);

    const publishDesc = document.createElement('p');
    publishDesc.className = 'halo-settings-subtle';
    publishDesc.textContent = '关闭后将默认保留为草稿，可在 Front Matter 中通过 halo.publish 覆盖。';
    panel.appendChild(publishDesc);

    const list = document.createElement('div');
    list.className = 'halo-site-list';
    panel.appendChild(list);

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'halo-btn ghost';
    addBtn.textContent = '新增站点';
    addBtn.addEventListener('click', () => {
      workingSites.push({
        id: randomUUID(),
        name: '',
        url: '',
        token: '',
        default: workingSites.length === 0
      });
      if (workingSites.length === 1) {
        workingSites[0].default = true;
      }
      refreshSites();
    });
    panel.appendChild(addBtn);

    const footer = document.createElement('div');
    footer.className = 'halo-settings-footer';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'halo-btn ghost';
    cancelBtn.textContent = '取消';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'halo-btn primary';
    saveBtn.textContent = '保存';
    footer.appendChild(cancelBtn);
    footer.appendChild(saveBtn);
    panel.appendChild(footer);

    const keyHandler = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(null);
      }
    };

    document.addEventListener('keydown', keyHandler);

    let closed = false;

    function close(result) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', keyHandler);
      if (overlay.parentElement) {
        overlay.parentElement.removeChild(overlay);
      }
      resolve(result);
    }

    closeBtn.addEventListener('click', () => close(null));
    cancelBtn.addEventListener('click', () => close(null));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        close(null);
      }
    });

    saveBtn.addEventListener('click', () => {
      const normalizedSites = [];
      for (const site of workingSites) {
        const normalizedSite = normalizeSite(site);
        if (!normalizedSite) {
          alert('请为每个站点填写有效的地址和 Token。');
          return;
        }
        normalizedSites.push(normalizedSite);
      }
      if (!normalizedSites.length) {
        alert('至少需要配置一个站点。');
        return;
      }
      if (!normalizedSites.some((site) => site.default)) {
        normalizedSites[0].default = true;
      }
      close({
        publishByDefault: !!working.publishByDefault,
        sites: normalizedSites
      });
    });

    function refreshSites() {
      list.innerHTML = '';
      if (!workingSites.length) {
        const empty = document.createElement('div');
        empty.className = 'halo-empty';
        empty.textContent = '尚未添加站点，点击“新增站点”开始配置。';
        list.appendChild(empty);
        return;
      }
      workingSites.forEach((site) => {
        list.appendChild(createSiteCard(site));
      });
    }

    function createSiteCard(site) {
      const card = document.createElement('div');
      card.className = 'halo-site-item';
      card.dataset.siteId = site.id;

      const nameField = document.createElement('label');
      nameField.className = 'halo-field';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = '站点名称';
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.placeholder = '可选，例如：个人博客';
      nameInput.value = site.name || '';
      nameInput.addEventListener('input', () => {
        site.name = nameInput.value;
      });
      nameField.appendChild(nameSpan);
      nameField.appendChild(nameInput);

      const urlField = document.createElement('label');
      urlField.className = 'halo-field';
      const urlSpan = document.createElement('span');
      urlSpan.textContent = '站点地址';
      const urlInput = document.createElement('input');
      urlInput.type = 'text';
      urlInput.placeholder = 'https://example.com';
      urlInput.value = site.url || '';
      urlInput.addEventListener('input', () => {
        site.url = urlInput.value;
      });
      urlField.appendChild(urlSpan);
      urlField.appendChild(urlInput);

      const tokenField = document.createElement('label');
      tokenField.className = 'halo-field';
      const tokenSpan = document.createElement('span');
      tokenSpan.textContent = 'Personal Access Token';
      const tokenInput = document.createElement('input');
      tokenInput.type = 'text';
      tokenInput.placeholder = '需要 Post Manage 权限';
      tokenInput.autocomplete = 'off';
      tokenInput.value = site.token || '';
      tokenInput.addEventListener('input', () => {
        site.token = tokenInput.value;
      });
      tokenField.appendChild(tokenSpan);
      tokenField.appendChild(tokenInput);

      const actionRow = document.createElement('div');
      actionRow.className = 'halo-site-actions';
      const defaultLabel = document.createElement('label');
      defaultLabel.className = 'halo-radio';
      const defaultInput = document.createElement('input');
      defaultInput.type = 'radio';
      defaultInput.name = 'halo-site-default';
      defaultInput.value = site.id;
      defaultInput.checked = !!site.default;
      defaultInput.addEventListener('change', () => {
        if (!defaultInput.checked) return;
        workingSites.forEach((record) => {
          record.default = record.id === site.id;
        });
        list.querySelectorAll('input[name="halo-site-default"]').forEach((radio) => {
          radio.checked = radio.value === site.id;
        });
      });
      const defaultText = document.createElement('span');
      defaultText.textContent = '设为默认发布站点';
      defaultLabel.appendChild(defaultInput);
      defaultLabel.appendChild(defaultText);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'halo-site-remove';
      removeBtn.textContent = '删除';
      removeBtn.addEventListener('click', () => {
        if (workingSites.length === 1 && !confirm('这是唯一的站点，删除后需要重新添加，确定继续？')) {
          return;
        }
        workingSites = workingSites.filter((record) => record.id !== site.id);
        if (workingSites.length && !workingSites.some((record) => record.default)) {
          workingSites[0].default = true;
        }
        refreshSites();
      });

      actionRow.appendChild(defaultLabel);
      actionRow.appendChild(removeBtn);

      card.appendChild(nameField);
      card.appendChild(urlField);
      card.appendChild(tokenField);
      card.appendChild(actionRow);

      return card;
    }

    document.body.appendChild(overlay);
    refreshSites();
  });
}

function ensureSettingsStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('flymd-halo-settings-style')) return;
  const style = document.createElement('style');
  style.id = 'flymd-halo-settings-style';
  style.textContent = `
    .flymd-halo-settings-overlay {
      position: fixed;
      inset: 0;
      background: rgba(15, 23, 42, 0.55);
      z-index: 9999;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      backdrop-filter: blur(2px);
    }
    .flymd-halo-settings-panel {
      width: min(780px, 94vw);
      max-height: 90vh;
      background: var(--halo-panel-bg, var(--color-surface, #ffffff));
      color: var(--halo-panel-fg, var(--color-text, #111));
      border-radius: 18px;
      box-shadow: 0 30px 80px rgba(2, 6, 23, 0.35);
      padding: 24px 28px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      overflow: hidden;
    }
    .halo-settings-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .halo-settings-header h2 {
      margin: 0;
      font-size: 20px;
      font-weight: 600;
    }
    .halo-close-btn {
      border: none;
      background: transparent;
      font-size: 24px;
      cursor: pointer;
      line-height: 1;
      color: inherit;
    }
    .halo-settings-hint {
      margin: 0;
      color: rgba(15, 23, 42, 0.7);
      font-size: 14px;
    }
    .halo-toggle {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      font-weight: 500;
      cursor: pointer;
      user-select: none;
    }
    .halo-toggle input {
      width: 18px;
      height: 18px;
    }
    .halo-settings-subtle {
      margin: 0;
      color: rgba(15, 23, 42, 0.5);
      font-size: 12px;
    }
    .halo-site-list {
      flex: 1;
      overflow: auto;
      padding-right: 4px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .halo-site-item {
      border: 1px solid rgba(15, 23, 42, 0.12);
      border-radius: 12px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      background: rgba(249, 250, 251, 0.8);
    }
    .halo-field {
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: 13px;
    }
    .halo-field span {
      color: rgba(15, 23, 42, 0.72);
      font-weight: 500;
    }
    .halo-field input {
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid rgba(15, 23, 42, 0.18);
      background: rgba(255, 255, 255, 0.9);
      font-size: 13px;
    }
    .halo-site-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .halo-radio {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      cursor: pointer;
      user-select: none;
    }
    .halo-site-remove {
      border: none;
      background: rgba(239, 68, 68, 0.12);
      color: #b91c1c;
      border-radius: 8px;
      padding: 6px 12px;
      font-size: 13px;
      cursor: pointer;
    }
    .halo-btn {
      border-radius: 8px;
      padding: 8px 16px;
      font-size: 14px;
      border: none;
      cursor: pointer;
    }
    .halo-btn.ghost {
      background: rgba(15, 23, 42, 0.05);
      color: inherit;
    }
    .halo-btn.primary {
      background: #2563eb;
      color: #fff;
      font-weight: 600;
    }
    .halo-settings-footer {
      display: flex;
      justify-content: flex-end;
      gap: 12px;
      margin-top: 8px;
    }
    .halo-empty {
      padding: 32px;
      text-align: center;
      border: 1px dashed rgba(15, 23, 42, 0.3);
      border-radius: 12px;
      color: rgba(15, 23, 42, 0.6);
      font-size: 14px;
    }
  `;
  document.head.appendChild(style);
}

function createHaloClient(context, site) {
  const baseUrl = site.url.replace(/\/+$/, '');

  async function request(path, init = {}) {
    const headers = Object.assign(
      {
        Authorization: `Bearer ${site.token}`
      },
      init.headers || {}
    );

    if (init.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await context.http.fetch(`${baseUrl}${path}`, {
      method: init.method || 'GET',
      headers,
      body: init.body
    });

    if (!response.ok) {
      const detail = await safeReadBody(response);
      throw new Error(`请求失败: ${response.status} ${detail || response.statusText}`);
    }

    return response;
  }

  async function requestJson(path, init = {}) {
    const res = await request(path, init);
    return await res.json();
  }

  return {
    async getPost(name) {
      try {
        const post = await requestJson(`/apis/uc.api.content.halo.run/v1alpha1/posts/${name}`);
        const snapshot = await requestJson(`/apis/uc.api.content.halo.run/v1alpha1/posts/${name}/draft?patched=true`);
        const annotations = (snapshot.metadata && snapshot.metadata.annotations) || {};
        const patchedContent = annotations['content.halo.run/patched-content'] || '';
        const patchedRaw = annotations['content.halo.run/patched-raw'] || '';
        const rawType = (snapshot.spec && snapshot.spec.rawType) || 'markdown';
        return {
          post,
          content: {
            content: patchedContent,
            raw: patchedRaw,
            rawType
          }
        };
      } catch (error) {
        console.warn('[flymd-halo] 获取文章失败', error);
        return null;
      }
    },

    async createPost(post, content, doc) {
      const payload = { ...post };
      payload.metadata = { ...payload.metadata };
      payload.metadata.name = randomUUID();
      payload.metadata.annotations = Object.assign({}, payload.metadata.annotations, {
        'content.halo.run/content-json': JSON.stringify(content)
      });
      payload.spec = { ...payload.spec };
      payload.spec.title = doc.frontmatter.title || extractTitleFromMarkdown(doc.body);
      payload.spec.slug = doc.frontmatter.slug || slugify(payload.spec.title);

      const created = await requestJson(`/apis/uc.api.content.halo.run/v1alpha1/posts`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      return created;
    },

    async updatePost(post, content) {
      const payload = { ...post };
      payload.metadata = { ...payload.metadata };
      const name = payload.metadata.name;

      await request(`/apis/uc.api.content.halo.run/v1alpha1/posts/${name}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });

      const snapshot = await requestJson(`/apis/uc.api.content.halo.run/v1alpha1/posts/${name}/draft?patched=true`);
      snapshot.metadata = snapshot.metadata || {};
      snapshot.metadata.annotations = Object.assign({}, snapshot.metadata.annotations, {
        'content.halo.run/content-json': JSON.stringify(content)
      });

      await request(`/apis/uc.api.content.halo.run/v1alpha1/posts/${name}/draft`, {
        method: 'PUT',
        body: JSON.stringify(snapshot)
      });
    },

    async changePostPublish(name, publish) {
      await request(`/apis/uc.api.content.halo.run/v1alpha1/posts/${name}/${publish ? 'publish' : 'unpublish'}`, {
        method: 'PUT'
      });
    },

    async getCategories() {
      const json = await requestJson(`/apis/content.halo.run/v1alpha1/categories`);
      return json.items || [];
    },

    async getTags() {
      const json = await requestJson(`/apis/content.halo.run/v1alpha1/tags`);
      return json.items || [];
    },

    async ensureCategoryNames(displayNames) {
      const all = await this.getCategories();
      const existing = [];
      const creations = [];

      displayNames.forEach((name) => {
        const found = all.find((item) => (item.spec?.displayName || '').toLowerCase() === name.toLowerCase());
        if (found) {
          existing.push(found.metadata.name);
        } else {
          creations.push(name);
        }
      });

      const created = [];
      for (const name of creations) {
        const result = await requestJson(`/apis/content.halo.run/v1alpha1/categories`, {
          method: 'POST',
          body: JSON.stringify({
            apiVersion: 'content.halo.run/v1alpha1',
            kind: 'Category',
            metadata: { name: '', generateName: 'category-' },
            spec: {
              displayName: name,
              slug: slugify(name),
              description: '',
              cover: '',
              template: '',
              priority: all.length + created.length,
              children: []
            }
          })
        });
        created.push(result.metadata.name);
      }

      return [...existing, ...created];
    },

    async ensureTagNames(displayNames) {
      const all = await this.getTags();
      const existing = [];
      const creations = [];

      displayNames.forEach((name) => {
        const found = all.find((item) => (item.spec?.displayName || '').toLowerCase() === name.toLowerCase());
        if (found) {
          existing.push(found.metadata.name);
        } else {
          creations.push(name);
        }
      });

      const created = [];
      for (const name of creations) {
        const result = await requestJson(`/apis/content.halo.run/v1alpha1/tags`, {
          method: 'POST',
          body: JSON.stringify({
            apiVersion: 'content.halo.run/v1alpha1',
            kind: 'Tag',
            metadata: { name: '', generateName: 'tag-' },
            spec: {
              displayName: name,
              slug: slugify(name),
              color: '#ffffff',
              cover: ''
            }
          })
        });
        created.push(result.metadata.name);
      }

      return [...existing, ...created];
    },

    async getCategoryDisplayNames(names = []) {
      if (!names.length) return [];
      const all = await this.getCategories();
      return names
        .map((name) => {
          const found = all.find((item) => item.metadata?.name === name);
          return found ? found.spec?.displayName : null;
        })
        .filter(Boolean);
    },

    async getTagDisplayNames(names = []) {
      if (!names.length) return [];
      const all = await this.getTags();
      return names
        .map((name) => {
          const found = all.find((item) => item.metadata?.name === name);
          return found ? found.spec?.displayName : null;
        })
        .filter(Boolean);
    }
  };
}

function createEmptyPost() {
  return {
    apiVersion: 'content.halo.run/v1alpha1',
    kind: 'Post',
    metadata: {
      annotations: {},
      name: ''
    },
    spec: {
      allowComment: true,
      baseSnapshot: '',
      categories: [],
      cover: '',
      deleted: false,
      excerpt: {
        autoGenerate: true,
        raw: ''
      },
      headSnapshot: '',
      htmlMetas: [],
      owner: '',
      pinned: false,
      priority: 0,
      publish: false,
      publishTime: '',
      releaseSnapshot: '',
      slug: '',
      tags: [],
      template: '',
      title: '',
      visible: 'PUBLIC'
    }
  };
}

function createEmptyContent() {
  return {
    rawType: 'markdown',
    raw: '',
    content: ''
  };
}

function applyFrontMatterToPost(frontmatter, post) {
  if (frontmatter.title) {
    post.spec.title = String(frontmatter.title);
  }
  if (frontmatter.slug) {
    post.spec.slug = String(frontmatter.slug);
  }
  if (frontmatter.cover) {
    post.spec.cover = String(frontmatter.cover);
  }
  if (frontmatter.excerpt) {
    post.spec.excerpt = {
      autoGenerate: false,
      raw: String(frontmatter.excerpt)
    };
  } else {
    post.spec.excerpt = {
      autoGenerate: true,
      raw: ''
    };
  }
}

function parseDocument(text) {
  if (!text.startsWith('---\n')) {
    return { frontmatter: {}, body: text, hasFrontMatter: false };
  }
  const lines = text.split('\n');
  let endIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) {
    return { frontmatter: {}, body: text, hasFrontMatter: false };
  }

  const frontmatterLines = lines.slice(1, endIndex);
  const bodyLines = lines.slice(endIndex + 1);
  const fmText = frontmatterLines.join('\n');
  const frontmatter = parseYaml(fmText);
  const body = bodyLines.join('\n');

  return {
    frontmatter,
    body,
    hasFrontMatter: true
  };
}

function parseYaml(text) {
  const lines = text.split('\n');
  const root = {};
  const stack = [{ indent: -1, value: root, type: 'object' }];

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const indent = rawLine.match(/^\s*/)[0].length;
    const line = rawLine.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const parentEntry = stack[stack.length - 1];
    let parent = parentEntry.value;

    if (line.startsWith('- ')) {
      if (!Array.isArray(parent)) {
        continue;
      }
      const valueText = line.slice(2).trim();
      if (!valueText) {
        const obj = {};
        parent.push(obj);
        stack.push({ indent, value: obj, type: 'object' });
      } else if (valueText.includes(':')) {
        const [k, ...rest] = valueText.split(':');
        const obj = {};
        obj[k.trim()] = parseYamlValue(rest.join(':').trim());
        parent.push(obj);
      } else {
        parent.push(parseYamlValue(valueText));
      }
      continue;
    }

    const [keyPart, ...rest] = line.split(':');
    const key = keyPart.trim();
    const valuePart = rest.join(':');

    if (!key) continue;

    if (!valuePart || valuePart.trim() === '') {
      const next = peekNextMeaningfulLine(lines, i + 1);
      if (next && next.indent > indent && next.line.trim().startsWith('-')) {
        parent[key] = [];
        stack.push({ indent, value: parent[key], type: 'array' });
      } else if (next && next.indent > indent) {
        parent[key] = {};
        stack.push({ indent, value: parent[key], type: 'object' });
      } else {
        parent[key] = {};
      }
    } else {
      parent[key] = parseYamlValue(valuePart.trim());
    }
  }

  return root;
}

function peekNextMeaningfulLine(lines, startIndex) {
  for (let i = startIndex; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    return {
      indent: lines[i].match(/^\s*/)[0].length,
      line: lines[i]
    };
  }
  return null;
}

function parseYamlValue(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (!Number.isNaN(Number(value))) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function buildDocument(frontmatter, body) {
  const yaml = stringifyYaml(frontmatter);
  const fmBlock = `---\n${yaml}\n---\n\n`;
  const trimmedBody = body.replace(/^\n+/, '');
  return fmBlock + trimmedBody;
}

function stringifyYaml(obj, indent = 0) {
  const lines = [];
  const keys = Object.keys(obj || {});
  for (const key of keys) {
    const value = obj[key];
    if (value === undefined || value === null || value === '') continue;
    const prefix = ' '.repeat(indent);
    if (Array.isArray(value)) {
      if (!value.length) continue;
      lines.push(`${prefix}${key}:`);
      value.forEach((item) => {
        if (item && typeof item === 'object') {
          lines.push(`${prefix}  -`);
          lines.push(stringifyYaml(item, indent + 4));
        } else {
          lines.push(`${prefix}  - ${formatScalar(item)}`);
        }
      });
    } else if (typeof value === 'object') {
      lines.push(`${prefix}${key}:`);
      lines.push(stringifyYaml(value, indent + 2));
    } else {
      lines.push(`${prefix}${key}: ${formatScalar(value)}`);
    }
  }
  return lines.join('\n');
}

function formatScalar(value) {
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  const str = String(value);
  if (str.includes(':') || str.includes('#') || str.includes('- ') || str.includes('"') || /^\s|\s$/.test(str)) {
    return `"${str.replace(/"/g, '\\"')}"`;
  }
  return str;
}

function normalizeStringArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function extractTitleFromMarkdown(text) {
  const firstHeading = text.match(/^#\s+(.+)$/m);
  if (firstHeading) {
    return firstHeading[1].trim();
  }
  const firstLine = text.split('\n').find((line) => line.trim());
  return firstLine ? firstLine.trim().slice(0, 80) : '未命名文章';
}

function slugify(input) {
  return String(input || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase() || randomUUID();
}

function randomUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function safeNotice(context, message, level = 'ok', ms = 2200) {
  try {
    context.ui.notice(message, level, ms);
  } catch (error) {
    console.log('[flymd-halo]', message);
  }
}

function runSafe(fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      result.catch((error) => console.error('[flymd-halo] 运行失败', error));
    }
  } catch (error) {
    console.error('[flymd-halo] 运行失败', error);
  }
}

async function safeReadBody(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

async function renderMarkdown(markdown) {
  const engine = await ensureMarkedLoaded();
  if (engine && typeof engine.parse === 'function') {
    return engine.parse(markdown);
  }
  return basicMarkdownRenderer(markdown);
}

async function ensureMarkedLoaded() {
  if (typeof window === 'undefined') return null;
  if (window.__flymdHaloMarked) return window.__flymdHaloMarked;
  if (window.marked) {
    window.__flymdHaloMarked = window.marked;
    return window.marked;
  }
  try {
    await loadScriptOnce('https://cdn.jsdelivr.net/npm/marked/marked.min.js', '__flymdHaloMarkedScript');
    if (window.marked) {
      window.__flymdHaloMarked = window.marked;
      return window.marked;
    }
  } catch (error) {
    console.warn('[flymd-halo] 无法加载 marked 库，将使用简易渲染器', error);
  }
  return null;
}

function loadScriptOnce(src, id) {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('document 不可用'));
      return;
    }
    if (document.getElementById(id)) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.id = id;
    script.src = src;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onload = () => resolve();
    script.onerror = (error) => reject(error);
    document.head.appendChild(script);
  });
}

function basicMarkdownRenderer(text) {
  const lines = text.split('\n');
  let html = '';
  let inCode = false;
  let codeLang = '';
  const listBuffer = [];

  const flushList = () => {
    if (listBuffer.length) {
      html += '<ul>' + listBuffer.join('') + '</ul>';
      listBuffer.length = 0;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine;
    if (line.startsWith('```')) {
      if (inCode) {
        html += `<pre><code class="language-${escapeHtml(codeLang)}">${escapeHtml(listBuffer.join('\n'))}</code></pre>`;
        listBuffer.length = 0;
        inCode = false;
        codeLang = '';
      } else {
        flushList();
        inCode = true;
        codeLang = line.slice(3).trim();
        listBuffer.length = 0;
      }
      continue;
    }

    if (inCode) {
      listBuffer.push(line);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const textContent = line.replace(/^\s*[-*+]\s+/, '');
      listBuffer.push(`<li>${inlineMarkdown(textContent)}</li>`);
      continue;
    } else {
      flushList();
    }

    if (!line.trim()) {
      html += '<br />';
      continue;
    }

    if (/^#{1,6}\s+/.test(line)) {
      const level = line.match(/^#+/)[0].length;
      const content = line.replace(/^#{1,6}\s+/, '');
      html += `<h${level}>${inlineMarkdown(content)}</h${level}>`;
      continue;
    }

    if (line.startsWith('>')) {
      html += `<blockquote>${inlineMarkdown(line.replace(/^>\s?/, ''))}</blockquote>`;
      continue;
    }

    html += `<p>${inlineMarkdown(line)}</p>`;
  }

  flushList();

  if (inCode && listBuffer.length) {
    html += `<pre><code>${escapeHtml(listBuffer.join('\n'))}</code></pre>`;
  }

  return html;
}

function inlineMarkdown(text) {
  let output = escapeHtml(text);
  output = output.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  output = output.replace(/\*(.+?)\*/g, '<em>$1</em>');
  output = output.replace(/`([^`]+)`/g, '<code>$1</code>');
  output = output.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return output;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
