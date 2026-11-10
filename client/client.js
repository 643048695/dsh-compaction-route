/**
 * dsh-compaction-route — browser half: the bundle's own configuration card.
 *
 * Hand-written lazy bundle (`window.__ModuleLoader__.load`), no build step and no
 * imports beyond React — the same shape every working third-party settings card in
 * this deployment uses.
 *
 * It renders into `plugins.bundle.config`, the seat for a bundle's own
 * configuration, keyed by the bundle's package name.
 *
 * Two seams carry the data:
 *   - `remote.settings.describe()` returns every active settings namespace. The
 *     `llm-pi-ai` namespace is where this profile declares its providers and
 *     their models, so the dropdowns are built from the models actually
 *     installed rather than a hard-coded list. The same call carries this
 *     plugin's own namespace, its current values and its revision.
 *   - `remote.settings.update(ns, patch, revision)` writes the chosen route back.
 *
 * The context-window hint exists because a fallback only rescues an oversized
 * replay when its window is BIGGER than the primary's; two same-size routes just
 * repeat the same rejection. The card says so when the pick looks unable to help.
 *
 * The two engine switches sit above the routing block because they are a
 * different job: routing decides WHICH model writes the summary, while the
 * switches decide WHETHER the engine condenses at all. Each is a plain checkbox
 * that writes immediately, so no save button is needed.
 *
 * @module dsh-compaction-route/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-compaction-route',
  factory: (require) => {
    /** Settings namespace owned by the host half; equals the row id in the patch. */
    const NS = 'compaction-route'
    /** The namespace whose value lists every installed provider and model. */
    const LLM_NS = 'llm-pi-ai'
    /** Separator between provider and model inside one stored value. */
    const SEP = '|'

    /** Every user-facing string, in both languages. */
    const S = {
      zh: {
        heading: '会话压缩',
        intro: '下面两个开关决定引擎什么时候自动压缩；再下面是压缩用哪个模型写摘要。手动 /compact 始终可用，不受这两个开关影响。',
        gate: '换模型前先压到新模型容量以内',
        gateHint: '开着：切到窗口更小的模型时，先把历史压小再发出去。关掉：直接发，装不下就由上游报「内容太长」。',
        auto: '自动压缩',
        autoHint: '开着：上下文接近上限时自动压缩、溢出后自动恢复。关掉：只在你自己敲 /compact 时才压。',
        routingHeading: '压缩模型路由',
        routingIntro: '压缩时用哪个模型写摘要。主模型失败（例如放不下整段历史）时自动换兜底模型重试。只影响压缩调用，不影响正常对话。',
        enabled: '启用路由',
        primary: '主模型',
        fallback: '兜底模型',
        fallbackNone: '（不使用兜底）',
        effort: '推理强度',
        effortDefault: '（跟随模型默认）',
        loading: '读取中…',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        savedRestart: '已保存。下一个压缩任务即刻生效，无需重启。',
        noSettings: '设置服务不可用，无法编辑。',
        saveFailed: (reason) => '保存失败：' + reason,
        loadFailed: (reason) => '读取失败：' + reason,
        models: (n) => '共 ' + n + ' 个可选模型',
        windowLabel: '上下文',
        warnSmaller: '兜底模型的上下文不比主模型大 —— 主模型因为「装不下」失败时，它很可能同样装不下。建议选一个窗口更大的。',
        warnSameModel: '主模型和兜底模型是同一个。',
        warnAutoOff: '自动压缩已关闭：引擎不会自己压了。上下文涨满后请求会被上游拒绝，届时你需要自己敲 /compact。',
        disabledHint: '路由已关闭：压缩继续使用引擎自己的设置。',
        noPrimary: '还没选主模型：压缩暂时保持原样，选一个模型后开始生效。',
        pick: '（选择一个模型）'
      },
      en: {
        heading: 'Compaction',
        intro: 'The two switches below decide when the engine condenses on its own; the block under them decides which model writes the summary. The manual /compact command always works, regardless of both switches.',
        gate: 'Condense to fit the destination model before switching',
        gateHint: 'On: switching to a smaller window condenses the history first. Off: the switch goes straight through, and an oversized history surfaces the provider\u2019s own "too long" error.',
        auto: 'Automatic compaction',
        autoHint: 'On: condense as the context nears its limit and recover from overflow. Off: condense only when you run /compact yourself.',
        routingHeading: 'Compaction model routing',
        routingIntro: 'Which model writes the summary when the context is compacted. If the primary fails — for example when the replay does not fit — the fallback is tried automatically. Only compaction calls are affected; normal turns are untouched.',
        enabled: 'Enable routing',
        primary: 'Primary model',
        fallback: 'Fallback model',
        fallbackNone: '(no fallback)',
        effort: 'Reasoning effort',
        effortDefault: '(provider default)',
        loading: 'Loading…',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        savedRestart: 'Saved. The next compaction uses it; no restart needed.',
        noSettings: 'The settings service is unavailable; this card cannot edit anything.',
        saveFailed: (reason) => 'Save failed: ' + reason,
        loadFailed: (reason) => 'Load failed: ' + reason,
        models: (n) => n + ' models available',
        windowLabel: 'window',
        warnSmaller: 'The fallback\u2019s context window is not larger than the primary\u2019s — when the primary fails because the replay does not fit, this fallback very likely will not fit either. Prefer a bigger window.',
        warnSameModel: 'Primary and fallback are the same model.',
        warnAutoOff: 'Automatic compaction is off: the engine will no longer condense on its own. Once the context is full the provider rejects the request, and you will need to run /compact yourself.',
        disabledHint: 'Routing is off: compaction keeps using the engine\u2019s own settings.',
        noPrimary: 'No primary picked yet: compaction stays untouched until you choose one.',
        pick: '(pick a model)'
      }
    }

    /** The active language, from the client locale service. */
    function langOf (ctx) {
      try {
        const locale = ctx.locale
        if (locale === undefined || typeof locale.getLocale !== 'function') return 'en'
        const snapshot = locale.getLocale()
        const active = snapshot !== null && snapshot !== undefined ? snapshot.active : undefined
        return typeof active === 'string' && active.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
      } catch {
        return 'en'
      }
    }

    /** Human-readable context window. */
    function humanWindow (value) {
      if (typeof value !== 'number' || !isFinite(value) || value <= 0) return undefined
      if (value >= 1000000) return (Math.round(value / 10000) / 100) + 'M'
      return Math.round(value / 1000) + 'k'
    }

    /**
     * Build the card component bound to one client context.
     *
     * @param {object} React - the browser module table's React.
     * @param {object} ctx - the client plugin context.
     * @returns {Function} the card component.
     */
    function makeCard (React, ctx) {
      const h = React.createElement

      /** Read one remote namespace defensively: absent services are not errors. */
      function remote (path) {
        const parts = path.split('.')
        let node = ctx
        for (const part of parts) {
          if (node === undefined || node === null) return undefined
          node = node[part]
        }
        return node
      }

      /** Resolve a RemoteResult to its value, or undefined on any failure. */
      function valueOf (response) {
        if (response === undefined || response === null) return undefined
        if (response.ok === false) return undefined
        return response.value
      }

      /** Normalise `settings.describe()` output: an array or `{namespaces}`. */
      function namespacesOf (described) {
        if (Array.isArray(described)) return described
        if (described !== null && typeof described === 'object' && Array.isArray(described.namespaces)) {
          return described.namespaces
        }
        return []
      }

      /** One option per installed model, carrying its provider and window. */
      function optionsOf (namespaces) {
        const llm = namespaces.find((entry) => entry !== null && entry !== undefined && entry.ns === LLM_NS)
        const providers = llm !== undefined && llm.value !== null && typeof llm.value === 'object'
          ? llm.value.providers
          : undefined
        if (providers === null || typeof providers !== 'object') return []
        const rows = []
        for (const provider of Object.keys(providers)) {
          const models = providers[provider] === null || typeof providers[provider] !== 'object'
            ? undefined
            : providers[provider].models
          if (!Array.isArray(models)) continue
          for (const model of models) {
            if (model === null || typeof model !== 'object' || typeof model.id !== 'string') continue
            const window = humanWindow(model.contextWindow)
            rows.push({
              value: provider + SEP + model.id,
              provider,
              model: model.id,
              window: typeof model.contextWindow === 'number' ? model.contextWindow : undefined,
              label: model.id + (window === undefined ? '' : '  \u00b7 ' + window)
            })
          }
        }
        return rows
      }

      const boxStyle = {
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))',
        borderRadius: '10px',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px'
      }
      const rowStyle = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' }
      const labelStyle = { minWidth: '104px', fontSize: '13px', opacity: 0.85 }
      const selectStyle = {
        minWidth: '340px',
        maxWidth: '100%',
        padding: '4px 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        color: 'inherit',
        fontSize: '13px'
      }
      const noteStyle = { fontSize: '12px', opacity: 0.75, lineHeight: 1.5 }
      const hintStyle = { fontSize: '12px', opacity: 0.7, lineHeight: 1.5, marginTop: '-4px' }
      const switchBlockStyle = {
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        padding: '10px 12px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.2))'
      }
      const warnStyle = {
        fontSize: '12px',
        lineHeight: 1.5,
        padding: '8px 10px',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-warning, rgba(255,193,7,0.12))',
        border: '1px solid rgba(255,193,7,0.35)'
      }

      return function CompactionRouteCard () {
        const [lang, setLang] = React.useState(langOf(ctx))
        const [state, setState] = React.useState('loading')
        const [note, setNote] = React.useState('')
        const [revision, setRevision] = React.useState(undefined)
        const [options, setOptions] = React.useState([])
        const [draft, setDraft] = React.useState({
          enabled: true,
          primary: '',
          fallback: '',
          effort: '',
          gate: true,
          auto: true
        })
        const [busy, setBusy] = React.useState(false)
        const t = S[lang]

        React.useEffect(() => {
          const locale = ctx.locale
          if (locale === undefined || typeof locale.subscribe !== 'function') return undefined
          setLang(langOf(ctx))
          return locale.subscribe(() => setLang(langOf(ctx)))
        }, [])

        const load = React.useCallback(async () => {
          try {
            const settingsApi = remote('remote.settings')
            if (settingsApi === undefined || typeof settingsApi.describe !== 'function') {
              setState('unavailable')
              return
            }
            const namespaces = namespacesOf(valueOf(await settingsApi.describe()))
            setOptions(optionsOf(namespaces))
            const mine = namespaces.find((entry) => entry !== null && entry !== undefined && entry.ns === NS)
            if (mine === undefined) {
              setState('missing')
              return
            }
            const value = mine.value !== null && typeof mine.value === 'object' ? mine.value : {}
            setDraft({
              enabled: value.enabled !== false,
              primary: typeof value.primary === 'string' ? value.primary : '',
              fallback: typeof value.fallback === 'string' ? value.fallback : '',
              effort: typeof value.effort === 'string' ? value.effort : '',
              gate: value.gate !== false,
              auto: value.auto !== false
            })
            setRevision(mine.revision)
            setState('ready')
            setNote('')
          } catch (error) {
            setState('failed')
            setNote(t.loadFailed(String(error)))
          }
        }, [t])

        React.useEffect(() => {
          load()
        }, [load])

        const save = React.useCallback(async (change) => {
          setBusy(true)
          setNote('')
          try {
            const settingsApi = remote('remote.settings')
            if (settingsApi === undefined || typeof settingsApi.update !== 'function') {
              setState('unavailable')
              return
            }
            await settingsApi.update(NS, change, revision)
            await load()
            setNote(t.savedRestart)
          } catch (error) {
            setNote(t.saveFailed(String(error)))
          } finally {
            setBusy(false)
          }
        }, [revision, load, t])

        if (state === 'loading') {
          return h('div', { style: boxStyle }, h('div', { style: noteStyle }, t.loading))
        }
        if (state === 'unavailable') {
          return h('div', { style: boxStyle }, h('div', { style: noteStyle }, t.noSettings))
        }

        const byValue = new Map(options.map((option) => [option.value, option]))
        const selectOf = (name, value, includeNone) => h(
          'select',
          {
            style: selectStyle,
            value,
            disabled: busy,
            onChange: (event) => {
              const next = event.currentTarget.value
              setDraft((current) => ({ ...current, [name]: next }))
              save({ [name]: next })
            }
          },
          [
            // An empty value must render as an explicit placeholder: otherwise the
            // browser shows the first real option while the stored value stays empty,
            // and the card would look like a model is selected when none is.
            includeNone
              ? h('option', { key: '__none', value: '' }, t.fallbackNone)
              : value === '' ? h('option', { key: '__pick', value: '' }, t.pick) : null,
            value !== '' && !byValue.has(value)
              ? h('option', { key: '__current', value }, value + '  (not installed)')
              : null,
            ...options.map((option) => h('option', { key: option.value, value: option.value }, option.label))
          ]
        )

        /** One checkbox row that writes on change, with its explanation underneath. */
        const switchOf = (name, title, hint) => h('div', { key: 'switch-' + name, style: switchBlockStyle }, [
          h('label', { key: 'label', style: rowStyle }, [
            h('input', {
              key: 'toggle',
              type: 'checkbox',
              checked: draft[name] === true,
              disabled: busy,
              onChange: (event) => {
                const next = event.currentTarget.checked === true
                setDraft((current) => ({ ...current, [name]: next }))
                save({ [name]: next })
              }
            }),
            h('span', { key: 'text', style: { fontSize: '13px' } }, title)
          ]),
          h('div', { key: 'hint', style: hintStyle }, hint)
        ])

        const primaryInfo = byValue.get(draft.primary)
        const fallbackInfo = byValue.get(draft.fallback)
        const bothKnown = primaryInfo !== undefined && fallbackInfo !== undefined
        const sameModel = bothKnown && draft.primary === draft.fallback
        const smallerWindow = bothKnown &&
          primaryInfo.window !== undefined &&
          fallbackInfo.window !== undefined &&
          fallbackInfo.window <= primaryInfo.window

        return h('div', { style: boxStyle }, [
          h('div', { key: 'heading', style: { fontSize: '14px', fontWeight: 600 } }, t.heading),
          h('div', { key: 'intro', style: noteStyle }, t.intro),
          switchOf('gate', t.gate, t.gateHint),
          switchOf('auto', t.auto, t.autoHint),
          draft.auto !== true
            ? h('div', { key: 'warn-auto', style: warnStyle }, t.warnAutoOff)
            : null,
          h('div', {
            key: 'routing-heading',
            style: { fontSize: '13px', fontWeight: 600, marginTop: '4px' }
          }, t.routingHeading),
          h('div', { key: 'routing-intro', style: noteStyle }, t.routingIntro),
          h('div', { key: 'enabled', style: rowStyle }, [
            h('span', { key: 'label', style: labelStyle }, t.enabled),
            h('input', {
              key: 'toggle',
              type: 'checkbox',
              checked: draft.enabled === true,
              disabled: busy,
              onChange: (event) => {
                const next = event.currentTarget.checked === true
                setDraft((current) => ({ ...current, enabled: next }))
                save({ enabled: next })
              }
            })
          ]),
          h('div', { key: 'primary', style: rowStyle }, [
            h('span', { key: 'label', style: labelStyle }, t.primary),
            selectOf('primary', draft.primary, false)
          ]),
          h('div', { key: 'fallback', style: rowStyle }, [
            h('span', { key: 'label', style: labelStyle }, t.fallback),
            selectOf('fallback', draft.fallback, true)
          ]),
          h('div', { key: 'effort', style: rowStyle }, [
            h('span', { key: 'label', style: labelStyle }, t.effort),
            h(
              'select',
              {
                style: { ...selectStyle, minWidth: '160px' },
                value: draft.effort,
                disabled: busy,
                onChange: (event) => {
                  const next = event.currentTarget.value
                  setDraft((current) => ({ ...current, effort: next }))
                  save({ effort: next })
                }
              },
              [
                h('option', { key: '', value: '' }, t.effortDefault),
                ...['low', 'medium', 'high', 'xhigh', 'max'].map((level) => h('option', { key: level, value: level }, level))
              ]
            )
          ]),
          smallerWindow
            ? h('div', { key: 'warn', style: warnStyle }, t.warnSmaller)
            : null,
          sameModel
            ? h('div', { key: 'warn-same', style: warnStyle }, t.warnSameModel)
            : null,
          draft.enabled !== true
            ? h('div', { key: 'off', style: noteStyle }, t.disabledHint)
            : draft.primary === ''
              ? h('div', { key: 'noprimary', style: noteStyle }, t.noPrimary)
              : null,
          h('div', { key: 'status', style: noteStyle }, [
            busy ? t.saving : '',
            note !== '' ? (busy ? '' : note) : '',
            options.length > 0 ? '\u00a0\u00b7 ' + t.models(options.length) : ''
          ].join(''))
        ])
      }
    }

    return {
      /**
       * The client services this card reads. `slots` places it, `locale` drives its
       * language, `remote` carries the settings calls.
       */
      inject: ['slots', 'locale', 'remote', 'remote.settings'],
      /**
       * Register the card into the bundle-configuration seat.
       *
       * @param {object} ctx - the client plugin context.
       */
      apply (ctx) {
        const slots = ctx.slots
        if (slots === undefined || typeof slots.inject !== 'function') return
        const React = require('react')
        const Card = makeCard(React, ctx)
        slots.inject('plugins.bundle.config', () => slots.register({
          name: 'plugins.bundle.config',
          key: 'dsh-compaction-route'
        }, Card))
      }
    }
  }
})
