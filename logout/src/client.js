window.__ModuleLoader__.load({
  id: '@dsh-hub/logout',
  factory: (require) => {
    const module = { exports: {} }
    const { jsx, jsxs } = require('react/jsx-runtime')

    const inject = ['slots', 'locale']

    function signOut() {
      const form = document.createElement('form')
      form.method = 'POST'
      form.action = '/logout'
      document.body.appendChild(form)
      form.submit()
    }

    function LogoutIcon() {
      return jsxs('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        children: [
          jsx('path', {
            d: 'M6.5 3.5H4.25C3.56 3.5 3 4.06 3 4.75v6.5c0 .69.56 1.25 1.25 1.25H6.5',
            stroke: 'currentColor',
            strokeWidth: 1.4,
            strokeLinecap: 'round',
          }),
          jsx('path', {
            d: 'M7 8h6.25M10.75 5.75 13.25 8l-2.5 2.25',
            stroke: 'currentColor',
            strokeWidth: 1.4,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        ],
      })
    }

    function LogoutButton({ wide, t }) {
      const label = t('logout')
      return jsxs('button', {
        type: 'button',
        'aria-label': label,
        onClick: signOut,
        onMouseEnter: (event) => {
          event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)'
        },
        onMouseLeave: (event) => {
          event.currentTarget.style.background = 'transparent'
        },
        style: wide
          ? {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: 'calc(100% + 8px)',
            height: 34,
            margin: '4px -4px',
            padding: '6px 2px 6px 10px',
            boxSizing: 'border-box',
            border: 'none',
            borderRadius: 12,
            background: 'transparent',
            cursor: 'pointer',
            color: 'var(--dsw-alias-label-primary)',
            fontFamily: 'inherit',
            fontSize: 14,
            lineHeight: '22px',
          }
          : {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 36,
            height: 36,
            margin: '8px 0 10px',
            padding: 0,
            border: 'none',
            borderRadius: '50%',
            background: 'transparent',
            cursor: 'pointer',
            color: 'var(--dsw-alias-label-primary)',
          },
        children: [
          jsx(LogoutIcon, {}),
          wide ? jsx('span', { children: label }) : null,
        ],
      })
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register('hub', {
        zh: { logout: '退出登录' },
        en: { logout: 'Sign out' },
      }), 'hub-logout: dictionaries')
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'hub-logout',
        order: 1000,
        locale: 'hub',
      }, LogoutButton))
    }

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
