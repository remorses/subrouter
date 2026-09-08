// Entry point for the subrouter docs website.
// Mounts holocron docs, a /gh redirect, and JSON Schema routes for ~/.subrouter files.

import '../style.css'
import { Spiceflow } from 'spiceflow'
import { app as holocronApp } from '@holocron.so/vite/app'
import { authJsonSchema, configJsonSchema } from '@subrouter/cli/src/schemas'

const schemaHeaders = { 'access-control-allow-origin': '*' }

export const app = new Spiceflow()
  .get('/gh', ({ request }) => {
    return Response.redirect('https://github.com/remorses/subrouter', 302)
  })
  .get('/schema.json', () => Response.json(configJsonSchema, { headers: schemaHeaders }))
  .get('/config.schema.json', () => Response.json(configJsonSchema, { headers: schemaHeaders }))
  .get('/auth.schema.json', () => Response.json(authJsonSchema, { headers: schemaHeaders }))
  .use(holocronApp)

export default {
  async fetch(request: Request): Promise<Response> {
    return app.handle(request)
  },
}
