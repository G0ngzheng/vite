import type * as http from 'http'
import httpProxy from 'http-proxy'
import type { Connect } from 'types/connect'
import type { HttpProxy } from 'types/http-proxy'
import colors from 'picocolors'
import { HMR_HEADER } from '../ws'
import { createDebugger, isObject } from '../../utils'
import type { CommonServerOptions, ResolvedConfig } from '../..'

const debug = createDebugger('vite:proxy')

export interface ProxyOptions extends HttpProxy.ServerOptions {
  /**
   * rewrite path
   */
  rewrite?: (path: string) => string
  /**
   * configure the proxy server (e.g. listen to events)
   */
  configure?: (proxy: HttpProxy.Server, options: ProxyOptions) => void
  /**
   * webpack-dev-server style bypass function
   */
  bypass?: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options: ProxyOptions
  ) => void | null | undefined | false | string
}

export function proxyMiddleware(
  httpServer: http.Server | null,
  options: NonNullable<CommonServerOptions['proxy']>,
  config: ResolvedConfig
): Connect.NextHandleFunction {
  // lazy require only when proxy is used
  const proxies: Record<string, [HttpProxy.Server, ProxyOptions]> = {}

  Object.keys(options).forEach((context) => {
    let opts = options[context]
    if (typeof opts === 'string') {
      opts = { target: opts, changeOrigin: true } as ProxyOptions
    }
    const proxy = httpProxy.createProxyServer(opts) as HttpProxy.Server

    proxy.on('error', (err, req, res) => {
      config.logger.error(`${colors.red(`http proxy error:`)}\n${err.stack}`, {
        timestamp: true,
        error: err
      })
      res
        .writeHead(500, {
          'Content-Type': 'text/plain'
        })
        .end()
    })

    if (opts.configure) {
      opts.configure(proxy, opts)
    }
    // clone before saving because http-proxy mutates the options
    proxies[context] = [proxy, { ...opts }]
  })

  if (httpServer) {
    httpServer.on('upgrade', (req, socket, head) => {
      const url = req.url!
      for (const context in proxies) {
        if (doesProxyContextMatchUrl(context, url)) {
          const [proxy, opts] = proxies[context]
          if (
            (opts.ws || opts.target?.toString().startsWith('ws:')) &&
            req.headers['sec-websocket-protocol'] !== HMR_HEADER
          ) {
            if (opts.rewrite) {
              req.url = opts.rewrite(url)
            }
            debug(`${req.url} -> ws ${opts.target}`)
            proxy.ws(req, socket, head)
            return
          }
        }
      }
    })
  }

  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return function viteProxyMiddleware(req, res, next) {
    const url = req.url!
    for (const context in proxies) {
      if (doesProxyContextMatchUrl(context, url)) {
        const [proxy, opts] = proxies[context]
        const options: HttpProxy.ServerOptions = {}

        if (opts.bypass) {
          const bypassResult = opts.bypass(req, res, opts)
          if (typeof bypassResult === 'string') {
            req.url = bypassResult
            debug(`bypass: ${req.url} -> ${bypassResult}`)
            return next()
          } else if (isObject(bypassResult)) {
            Object.assign(options, bypassResult)
            debug(`bypass: ${req.url} use modified options: %O`, options)
            return next()
          } else if (bypassResult === false) {
            debug(`bypass: ${req.url} -> 404`)
            return res.end(404)
          }
        }

        debug(`${req.url} -> ${opts.target || opts.forward}`)
        if (opts.rewrite) {
          req.url = opts.rewrite(req.url!)
        }
        proxy.web(req, res, options)
        return
      }
    }
    next()
  }
}

function doesProxyContextMatchUrl(context: string, url: string): boolean {
  return (
    (context.startsWith('^') && new RegExp(context).test(url)) ||
    url.startsWith(context)
  )
}
