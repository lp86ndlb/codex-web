Adapted from DeepSeek Harness, commit `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`.

Source: `packages/client/ui-primitives/src/` in the local upstream checkout.
The MIT license is retained in LICENSE. The upstream checkout is unchanged.

Reused: StateDot, DisclosureRow, TextShimmer, Checkbox, the Chinese emphasis
and TeX compatibility grammars, and KaTeX rendering. Host changes use Lucide
icon aliases, cweb theme tokens, animated disclosure/checkbox presentation,
and bounded untrusted TeX rendering. These modules do not load the DSH runtime.

The turn rail in `../TurnNavigator.tsx` adapts the prompt marks, hover preview,
and viewport tracking from `packages/client/ui-chat/src/client/chat/TurnNavigator`
at the same commit. cweb uses native Codex message ids, its own bounded history
window, and Lucide icons; no DSH projection or runtime is loaded.
