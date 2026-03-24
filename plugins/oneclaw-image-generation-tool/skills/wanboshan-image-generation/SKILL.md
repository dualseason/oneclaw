---
name: wanboshan-image-generation
description: "Generate images with the built-in Wanboshan image gateway via `oneclaw_generate_image`. Use when the user explicitly asks to create a new image, poster, icon, wallpaper, cover, illustration, concept art, or visual draft. Do not use Gemini official APIs directly for this flow."
homepage: https://claw.dualseason.com
metadata:
  {
    "openclaw":
      {
        "emoji": "🎨",
        "requires": { "config": ["models.providers.clawimage.apiKey"] },
      },
  }
---

# 万博山生图

Use the bundled `oneclaw_generate_image` tool for Wanboshan image generation.

## When to Use

Use this skill when the user explicitly wants a new image, for example:

- draw or generate an image
- create an illustration, poster, wallpaper, icon, logo, banner, or cover
- make concept art, visual direction, product mock art, or scene drafts
- create a stylized image from a text description

## When NOT to Use

Do not use this skill for:

- describing or analyzing an existing image
- OCR or visual understanding
- ordinary text-only answers
- image editing that requires uploading one or more source images

This skill currently targets text-to-image generation.

## Important Rules

- Always use `oneclaw_generate_image` for this flow.
- Do not call Gemini official APIs directly.
- Do not ask the user for a Gemini API key.
- The gateway URL, auth mode, and default image model are managed by the `clawimage` provider.
- If generation fails, surface the actual backend error instead of inventing a reason.

## Prompting Guidance

Before calling the tool:

1. Rewrite the user's request into a concise, production-ready image prompt.
2. Keep the prompt specific about subject, composition, style, lighting, mood, and background when helpful.
3. Preserve hard constraints exactly:
   exact text to render, subject count, color, aspect, brand elements, and forbidden content.
4. Prefer one strong prompt over a long list of vague adjectives.

## Tool Parameters

- `prompt`: required
- `size`: optional
  supported values: `1024x1024`, `1024x1536`, `1536x1024`, `auto`
- `quality`: optional
  supported values: `low`, `medium`, `high`, `auto`

## Example Calls

Square poster:

```json
{
  "prompt": "A minimalist travel poster of Hangzhou West Lake at sunrise, bold red accent palette, clean vector illustration, calm water reflections, premium editorial layout",
  "size": "1024x1024",
  "quality": "high"
}
```

Portrait illustration:

```json
{
  "prompt": "A young woman in a cream trench coat standing in light rain, cinematic composition, soft diffused light, realistic illustration, muted urban background",
  "size": "1024x1536",
  "quality": "high"
}
```

Landscape concept draft:

```json
{
  "prompt": "A futuristic tea house on a cliff above clouds, Chinese contemporary architecture, warm sunset rim light, atmospheric depth, concept art",
  "size": "1536x1024",
  "quality": "medium"
}
```

## Response Handling

After the tool returns:

- If successful, briefly tell the user what was generated.
- Do not restate the entire prompt unless useful.
- If the tool returns a revised prompt, mention it only when it materially changed the request.
- If the tool fails, report the returned error clearly and stop.
