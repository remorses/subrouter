<!-- Release history for the @subrouter/opencode package. -->

# Changelog

## 0.1.0

1. **Use every subrouter preset as an OpenCode model:** the plugin registers the `subrouter` provider and exposes the built-in `subrouter/default` model plus each user preset as `subrouter/<preset>`.

   ```json
   {
     "plugin": ["@subrouter/opencode"]
   }
   ```

   Restart OpenCode, then select `subrouter/default` or another configured preset.

2. **Fail over through the complete OpenCode pipeline:** when a subscription reaches a rate or usage limit, the request moves to the next eligible account or provider. OpenCode receives the underlying provider response without cross-provider wire-format translation.

3. **Load new presets on restart:** presets created with `npx @subrouter/cli preset create` are added to OpenCode's model list the next time OpenCode starts.
