// Entry point for the subrouter docs website.
// Mounts holocron docs, a /gh redirect, and JSON Schema routes for ~/.subrouter files.

import '../style.css'
import { Spiceflow } from 'spiceflow'
import { app as holocronApp } from '@holocron.so/vite/app'
import {
  accountsJsonSchema,
  loginJsonSchema,
  presetsJsonSchema,
  stateJsonSchema,
} from '@subrouter/cli/src/schemas'

const schemaHeaders = { 'access-control-allow-origin': '*' }

export const app = new Spiceflow()
  .get('/gh', ({ request }) => {
    return Response.redirect('https://github.com/remorses/subrouter', 302)
  })
  .get('/accounts.json', () => Response.json(accountsJsonSchema, { headers: schemaHeaders }))
  .get('/presets.json', () => Response.json(presetsJsonSchema, { headers: schemaHeaders }))
  .get('/state.json', () => Response.json(stateJsonSchema, { headers: schemaHeaders }))
  .get('/login.json', () => Response.json(loginJsonSchema, { headers: schemaHeaders }))
  .use(holocronApp)

export default {
  async fetch(request: Request): Promise<Response> {
    return app.handle(request)
  },
}
