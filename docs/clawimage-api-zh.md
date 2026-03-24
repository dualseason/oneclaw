# 万博生图接口说明

本文档描述 `https://claw.dualseason.com/v1` 当前可观测到的生图接口行为，供其他 AI 客户端、网关适配层或工具调用方对接。

说明：

- 本文档基于 2026-03-23 的真实联调结果整理
- 这是行为说明，不是后端源码说明
- 如果后端实现更新，应同步更新本文档

## 概览

- 基础地址：`https://claw.dualseason.com/v1`
- 鉴权方式：`Authorization: Bearer <API_KEY>`
- 模型列表接口：`GET /models`
- 当前已验证可用的生图模型：`gemini-3.0-pro-image-2k`
- 当前生图成功路径：`POST /chat/completions` 且 `stream: true`
- 当前图片结果返回形式：SSE 流中的 markdown 图片链接，不是普通 JSON `url` 字段

## 鉴权

请求头：

```http
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json
```

## 模型列表

请求：

```http
GET /v1/models
Authorization: Bearer YOUR_API_KEY
```

成功响应示例：

```json
{
  "data": [
    {
      "id": "gemini-3.0-pro-image-2k",
      "object": "model",
      "owned_by": "custom",
      "supported_endpoint_types": ["openai"]
    }
  ]
}
```

说明：

- `gemini-3.0-pro-image-2k` 当前可见且可进入生图流程
- 其他带 `image` 的模型是否可用，取决于 token 权限

## 当前可用的生图调用方式

### 请求路径

```http
POST /v1/chat/completions
Accept: text/event-stream
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json
```

### 推荐请求体

```json
{
  "model": "gemini-3.0-pro-image-2k",
  "messages": [
    {
      "role": "user",
      "content": "一只白色小猫坐在红色椅子上，简洁插画风格"
    }
  ],
  "modalities": ["text", "image"],
  "max_tokens": 512,
  "stream": true
}
```

### 行为说明

- 必须使用 `stream: true`
- 响应 `Content-Type` 为 `text/event-stream`
- 早期 chunk 一般出现在 `choices[0].delta.reasoning_content`
- 最终图片结果出现在某个 chunk 的 `choices[0].delta.content`
- `delta.content` 当前是 markdown 图片语法，而不是裸 URL

### 实际 SSE 结果形态

典型流式输出：

```text
data: {"choices":[{"delta":{"reasoning_content":"图片生成任务已启动"}}]}

data: {"choices":[{"delta":{"reasoning_content":"正在生成图片..."}}]}

data: {"choices":[{"delta":{"content":"![Generated Image](https://.../xxx_2K.jpg)"},"finish_reason":"stop"}]}

data: [DONE]
```

## 客户端解析规则

调用方应按下面逻辑取图：

1. 逐条读取 SSE `data:` 事件
2. 解析 JSON
3. 优先忽略 `delta.reasoning_content`
4. 读取 `choices[0].delta.content`
5. 从 `delta.content` 中提取 markdown 图片链接
6. 拿到 `https://...jpg` 或 `https://...png` 即视为生成成功

建议的正则：

```regex
!\[[^\]]*\]\(([^)\s]+)[^)]*\)
```

示例提取：

```text
![Generated Image](https://example.com/tmp/abc_2K.jpg)
```

提取结果：

```text
https://example.com/tmp/abc_2K.jpg
```

## 当前不建议使用的调用方式

以下方式在 2026-03-23 的联调中未打通：

### 非流式 `chat/completions`

请求：

```json
{
  "model": "gemini-3.0-pro-image-2k",
  "messages": [
    {
      "role": "user",
      "content": "一只白色小猫坐在红色椅子上，简洁插画风格"
    }
  ],
  "modalities": ["text", "image"],
  "stream": false
}
```

当前返回：

```json
{
  "error": {
    "message": "image mode enabled but response does not contain a URL",
    "type": "bad_response_body"
  }
}
```

结论：

- 当前后端的非流式图片结果不适合作为稳定对接方式

### `POST /v1/images/generations`

当前返回 `404 Not Found`。

### `POST /v1/responses`

当前返回 `404 Not Found`。

## 推荐对接方式

### 适合其他 AI / 客户端的最小策略

- 固定模型：`gemini-3.0-pro-image-2k`
- 固定路径：`POST /v1/chat/completions`
- 固定 `stream: true`
- 从 SSE 末尾 chunk 的 markdown 中提取图片 URL

### Node.js 示例

```js
const res = await fetch("https://claw.dualseason.com/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
    "Accept": "text/event-stream",
  },
  body: JSON.stringify({
    model: "gemini-3.0-pro-image-2k",
    messages: [{ role: "user", content: prompt }],
    modalities: ["text", "image"],
    max_tokens: 512,
    stream: true,
  }),
});
```

流式解析时，在每个 `data:` 事件里找：

```js
chunk.choices?.[0]?.delta?.content
```

然后从内容里提取：

```js
const match = /!\\[[^\\]]*\\]\\(([^)\\s]+)[^)]*\\)/.exec(content);
const imageUrl = match?.[1] ?? "";
```

## 已知限制

- 这是一个偏自定义的图片接口行为，不完全等同于标准 OpenAI Image API
- 当前图片结果依赖流式输出
- 当前图片结果不是结构化 `url` 字段，而是 markdown 文本
- 某些图片模型会返回 `403`，说明不同 token 的模型权限可能不同

## 对后端的建议

如果希望降低对接成本，建议后端至少补齐以下任一能力：

1. 实现标准 `POST /v1/images/generations`
   成功返回 `data[].url` 或 `data[].b64_json`
2. 保留当前流式接口，但在最终 chunk 里增加结构化字段
   例如：

```json
{
  "choices": [
    {
      "delta": {
        "image_url": "https://...jpg"
      }
    }
  ]
}
```

这样其他 AI 或 SDK 不需要额外解析 markdown。
