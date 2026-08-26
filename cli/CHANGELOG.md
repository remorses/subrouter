<!-- Release history for the @subrouter/cli package. -->

# Changelog

## 0.1.0

1. **Route requests across personal AI subscriptions:** use Claude Pro/Max, ChatGPT Plus/Pro, SuperGrok, and opencode Go accounts through one AI SDK provider. When an account reaches a rate or usage limit, subrouter tries the next account and then the next provider in the preset.

2. **Manage multiple subscription accounts from one CLI:** repeat `login` to add accounts to each provider pool, then inspect or remove them as needed:

   ```bash
   npx @subrouter/cli login anthropic
   npx @subrouter/cli login openai
   npx @subrouter/cli account list
   npx @subrouter/cli account remove openai me@example.com
   ```

3. **Create ranked model presets:** define the provider and model order once, then use the preset as `subrouter/<name>` in a supported harness:

   ```bash
   npx @subrouter/cli preset create work \
     --models 'anthropic/claude-opus-4-6,openai/gpt-5.5,xai/grok-4.6'
   npx @subrouter/cli preset show work
   ```

   The built-in `default` preset ranks the newest model for each configured provider. A user preset named `default` overrides it.

4. **Share cooldowns across every local process:** rate-limited accounts are stored in machine-wide cooldown state and skipped by all sessions. Use `status` to inspect the pool or clear cooldowns when an account is ready again:

   ```bash
   npx @subrouter/cli status
   npx @subrouter/cli cooldown clear
   ```

5. **Use subrouter as an AI SDK provider:** import `createSubrouter`, `RouterModel`, account storage helpers, and provider adapters from `@subrouter/cli` when building another personal harness integration.
