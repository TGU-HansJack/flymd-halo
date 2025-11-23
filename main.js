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
  state.settings = await loadSettings(context);
  await settingsPrompt(context, state.settings);
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

async function settingsPrompt(context, settings) {
  let exit = false;
  while (!exit) {
    const summary = formatSettingsSummary(settings);
    const answer = prompt(`${summary}\n\n请选择操作：\n1) 新增站点\n2) 编辑站点\n3) 删除站点\n4) 设置默认站点\n5) 切换默认发布状态（当前：${settings.publishByDefault ? '自动发布' : '草稿'}）\n0) 完成`, '0');
    if (answer === null || answer.trim() === '0') {
      exit = true;
      break;
    }
    switch (answer.trim()) {
      case '1':
        await handleAddSite(settings);
        break;
      case '2':
        await handleEditSite(settings);
        break;
      case '3':
        await handleRemoveSite(settings);
        break;
      case '4':
        await handleSetDefaultSite(settings);
        break;
      case '5':
        settings.publishByDefault = !settings.publishByDefault;
        safeNotice(context, `默认发布已切换为：${settings.publishByDefault ? '发布' : '草稿'}`, 'ok');
        break;
      default:
        safeNotice(context, '无效的选项', 'err');
        break;
    }
  }
}

async function handleAddSite(settings) {
  const name = prompt('请输入站点名称（可选）：', '') || '';
  const urlInput = prompt('请输入 Halo 站点地址（例如 https://example.com ）：', '');
  if (!urlInput) return;
  const url = normalizeSiteUrl(urlInput);
  if (!url) {
    alert('站点地址无效');
    return;
  }
  const token = prompt('请输入 Halo Personal Access Token：', '');
  if (!token) {
    alert('Token 不能为空');
    return;
  }
  const site = {
    id: randomUUID(),
    name: name.trim(),
    url,
    token: token.trim(),
    default: settings.sites.length === 0
  };
  settings.sites.push(site);
}

async function handleEditSite(settings) {
  if (!settings.sites.length) {
    alert('暂无站点可编辑');
    return;
  }
  const index = promptSiteIndex(settings, '请输入要编辑的站点编号：');
  if (index === null) return;
  const site = settings.sites[index];
  const name = prompt('站点名称：', site.name) ?? site.name;
  const urlInput = prompt('站点地址：', site.url) ?? site.url;
  const url = normalizeSiteUrl(urlInput);
  if (!url) {
    alert('站点地址无效');
    return;
  }
  const token = prompt('访问 Token：', site.token) ?? site.token;
  site.name = name.trim();
  site.url = url;
  site.token = token.trim();
}

async function handleRemoveSite(settings) {
  if (!settings.sites.length) {
    alert('暂无站点可删除');
    return;
  }
  const index = promptSiteIndex(settings, '请输入要删除的站点编号：');
  if (index === null) return;
  if (!confirm('确定删除该站点吗？')) return;
  const removed = settings.sites.splice(index, 1);
  if (removed[0]?.default && settings.sites.length) {
    settings.sites[0].default = true;
  }
}

async function handleSetDefaultSite(settings) {
  if (!settings.sites.length) {
    alert('请先添加站点');
    return;
  }
  const index = promptSiteIndex(settings, '请选择新的默认站点编号：');
  if (index === null) return;
  settings.sites.forEach((site, idx) => {
    site.default = idx === index;
  });
}

function promptSiteIndex(settings, message) {
  const list = settings.sites.map((site, index) => `${index + 1}. ${site.name || site.url}${site.default ? '（默认）' : ''}`).join('\n');
  const answer = prompt(`${message}\n\n${list}`, '1');
  if (answer === null) return null;
  const idx = Number(answer) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx >= settings.sites.length) {
    alert('无效的编号');
    return null;
  }
  return idx;
}

function formatSettingsSummary(settings) {
  if (!settings.sites.length) {
    return '当前尚未配置任何 Halo 站点。';
  }
  return settings.sites
    .map((site, index) => {
      const prefix = `${index + 1}. ${site.name || site.url}`;
      const suffix = site.default ? '（默认）' : '';
      return `${prefix} ${suffix}\n    ${site.url}`;
    })
    .join('\n');
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
