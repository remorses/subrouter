// Entry point for the subrouter docs website.
// Mounts holocron docs, a /gh redirect, and JSON Schema routes for ~/.subrouter files.

import '../style.css'
import { Spiceflow } from 'spiceflow'
import { app as holocronApp } from '@holocron.so/vite/app'
import { configJsonSchema } from '@subrouter/cli/src/schemas'

export const app = new Spiceflow()
  .get('/gh', ({ request }) => {
    return Response.redirect('https://github.com/remorses/subrouter', 302)
  })
  .get('/schema.json', () =>
    Response.json(configJsonSchema, { headers: { 'access-control-allow-origin': '*' } }),
  )
  .use(holocronApp)

export default {
  async fetch(request: Request): Promise<Response> {
    return app.handle(request)
  },
}
