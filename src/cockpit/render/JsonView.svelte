<script lang="ts">
  /**
   * The render layer's PUBLIC door for one JSON value.
   *
   * `JsonNode` is internal — recursive, carrying depth and key props that
   * only its own recursion should set — and the sanitization owner refuses
   * any mount of it from outside the render layer. A surface elsewhere in
   * the cockpit (the setting sheet's object read view, whatever renders
   * JSON next) mounts THIS instead: the root of the same tree, value only,
   * so every JSON rendering shares one implementation and the internal
   * stays internal.
   */
  import JsonNode from "./JsonNode.svelte";

  let { value }: { value: unknown } = $props();
</script>

<JsonNode {value} />
