# Web Search & Web Fetch 集成技术资料

> 本文档汇总了 Anthropic Web Search/Fetch API 和 Firecrawl API 的官方文档和技术细节
> 更新日期: 2026-01-08

## 一、Anthropic Web Search Tool

### 1.1 概述

- **功能**: 让 Claude 直接访问实时网络内容,使用最新信息回答问题
- **特性**: 
  - 自动引用搜索结果来源
  - 可控制搜索次数
  - 支持域名过滤(允许/阻止)
  - 支持位置本地化
  - 集成到 Claude API 响应流程中

### 1.2 支持的模型

- Claude Sonnet 4.5 (`claude-sonnet-4-5-20250929`)
- Claude Sonnet 4 (`claude-sonnet-4-20250514`)
- Claude Haiku 4.5 (`claude-haiku-4-5-20251001`)
- Claude Opus 4.5 (`claude-opus-4-5-20251101`)
- Claude Opus 4.1 (`claude-opus-4-1-20250805`)
- Claude Opus 4 (`claude-opus-4-20250514`)

### 1.3 工作流程

1. Claude 根据提示决定何时搜索
2. API 执行搜索并向 Claude 提供结果
3. Claude 提供带引用来源的最终响应

### 1.4 Tool 定义格式

```json
{
  "type": "web_search_20250305",
  "name": "web_search",
  "max_uses": 5,
  "allowed_domains": ["example.com", "trusteddomain.org"],
  "blocked_domains": ["untrustedsource.com"],
  "user_location": {
    "type": "approximate",
    "city": "San Francisco",
    "region": "California",
    "country": "US",
    "timezone": "America/Los_Angeles"
  }
}
```

**参数说明**:
- `max_uses`: 限制每个请求的搜索次数
- `allowed_domains`: 只包含这些域名的结果
- `blocked_domains`: 不包含这些域名的结果
- `user_location`: 本地化搜索结果

### 1.5 响应格式

```json
{
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "I'll search for when Claude Shannon was born."
    },
    {
      "type": "server_tool_use",
      "id": "srvtoolu_01WYG3ziw53XMcoyKL4XcZmE",
      "name": "web_search",
      "input": {
        "query": "claude shannon birth date"
      }
    },
    {
      "type": "web_search_tool_result",
      "tool_use_id": "srvtoolu_01WYG3ziw53XMcoyKL4XcZmE",
      "content": [
        {
          "type": "web_search_result",
          "url": "https://en.wikipedia.org/wiki/Claude_Shannon",
          "title": "Claude Shannon - Wikipedia",
          "encrypted_content": "EqgfCioIARgBIiQ3YTAwMjY1Mi1mZjM5LTQ1NGUtODgxNC1kNjNjNTk1ZWI3Y...",
          "page_age": "April 30, 2025"
        }
      ]
    },
    {
      "text": "Claude Shannon was born on April 30, 1916, in Petoskey, Michigan",
      "type": "text",
      "citations": [
        {
          "type": "web_search_result_location",
          "url": "https://en.wikipedia.org/wiki/Claude_Shannon",
          "title": "Claude Shannon - Wikipedia",
          "encrypted_index": "Eo8BCioIAhgBIiQyYjQ0OWJmZi1lNm..",
          "cited_text": "Claude Elwood Shannon (April 30, 1916 – February 24, 2001)..."
        }
      ]
    }
  ],
  "usage": {
    "input_tokens": 6039,
    "output_tokens": 931,
    "server_tool_use": {
      "web_search_requests": 1
    }
  }
}
```

**关键字段**:
- `server_tool_use`: 表示服务器端工具调用
- `web_search_tool_result`: 搜索结果
- `encrypted_content`: 加密内容(必须在多轮对话中传回)
- `citations`: 引用信息

### 1.6 错误处理

```json
{
  "type": "web_search_tool_result",
  "tool_use_id": "servertoolu_a93jad",
  "content": {
    "type": "web_search_tool_result_error",
    "error_code": "max_uses_exceeded"
  }
}
```

**错误码**:
- `too_many_requests`: 超出速率限制
- `invalid_input`: 无效的搜索查询参数
- `max_uses_exceeded`: 超出最大搜索次数
- `query_too_long`: 查询超过最大长度
- `unavailable`: 内部错误

### 1.7 定价

- **每 1,000 次搜索 $10**
- 加上搜索生成内容的标准 token 成本

---

## 二、Anthropic Web Fetch Tool

### 2.1 概述

- **功能**: 让 Claude 从指定网页和 PDF 文档检索完整内容
- **Beta 功能**: 需要在请求中使用 beta header `web-fetch-2025-09-10`
- **安全考虑**: 存在数据泄露风险,不建议在不受信任的环境中使用

### 2.2 工作流程

1. Claude 根据提示和可用 URL 决定何时获取内容
2. API 从指定 URL 检索完整文本内容
3. 对于 PDF,执行自动文本提取
4. Claude 分析获取的内容并提供响应(可选引用)

### 2.3 Tool 定义格式

```json
{
  "type": "web_fetch_20250910",
  "name": "web_fetch",
  "max_uses": 10,
  "allowed_domains": ["example.com", "docs.example.com"],
  "blocked_domains": ["private.example.com"],
  "citations": {
    "enabled": true
  },
  "max_content_tokens": 100000
}
```

**参数说明**:
- `max_uses`: 限制每个请求的获取次数(无默认限制)
- `allowed_domains`/`blocked_domains`: 域名过滤
- `citations`: 引用功能(可选,与 web search 不同)
- `max_content_tokens`: 内容令牌限制(近似值)

### 2.4 响应格式

```json
{
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "I'll fetch the content from the article to analyze it."
    },
    {
      "type": "server_tool_use",
      "id": "srvtoolu_01234567890abcdef",
      "name": "web_fetch",
      "input": {
        "url": "https://example.com/article"
      }
    },
    {
      "type": "web_fetch_tool_result",
      "tool_use_id": "srvtoolu_01234567890abcdef",
      "content": {
        "type": "web_fetch_result",
        "url": "https://example.com/article",
        "content": {
          "type": "document",
          "source": {
            "type": "text",
            "media_type": "text/plain",
            "data": "Full text content of the article..."
          },
          "title": "Article Title",
          "citations": {"enabled": true}
        },
        "retrieved_at": "2025-08-25T10:30:00Z"
      }
    },
    {
      "text": "the main argument presented is that artificial intelligence will transform healthcare",
      "type": "text",
      "citations": [
        {
          "type": "char_location",
          "document_index": 0,
          "document_title": "Article Title",
          "start_char_index": 1234,
          "end_char_index": 1456,
          "cited_text": "Artificial intelligence is poised to revolutionize healthcare delivery..."
        }
      ]
    }
  ],
  "usage": {
    "input_tokens": 25039,
    "output_tokens": 931,
    "server_tool_use": {
      "web_fetch_requests": 1
    }
  }
}
```

**PDF 响应格式**:
```json
{
  "type": "web_fetch_tool_result",
  "content": {
    "type": "web_fetch_result",
    "url": "https://example.com/paper.pdf",
    "content": {
      "type": "document",
      "source": {
        "type": "base64",
        "media_type": "application/pdf",
        "data": "JVBERi0xLjQKJcOkw7zDtsOfCjIgMCBvYmo..."
      },
      "citations": {"enabled": true}
    },
    "retrieved_at": "2025-08-25T10:30:02Z"
  }
}
```

### 2.5 错误处理

```json
{
  "type": "web_fetch_tool_result",
  "tool_use_id": "srvtoolu_a93jad",
  "content": {
    "type": "web_fetch_tool_error",
    "error_code": "url_not_accessible"
  }
}
```

**错误码**:
- `invalid_input`: 无效的 URL 格式
- `url_too_long`: URL 超过最大长度(250字符)
- `url_not_allowed`: URL 被域名过滤规则阻止
- `url_not_accessible`: 获取内容失败(HTTP错误)
- `too_many_requests`: 超出速率限制
- `unsupported_content_type`: 不支持的内容类型(仅支持文本和PDF)
- `max_uses_exceeded`: 超出最大使用次数
- `unavailable`: 内部错误

### 2.6 URL 验证

**重要限制**: Web fetch 工具只能获取之前在对话上下文中出现过的 URL:
- 用户消息中的 URL
- 客户端工具结果中的 URL
- 之前 web search 或 web fetch 结果中的 URL

### 2.7 定价

- **无额外费用** - 仅支付获取内容的标准 token 成本
- 典型内容的 token 使用量:
  - 平均网页(10KB): ~2,500 tokens
  - 大型文档页面(100KB): ~25,000 tokens
  - 研究论文 PDF(500KB): ~125,000 tokens

---

## 三、Firecrawl Search API

### 3.1 概述

- **功能**: 执行网络搜索并可选地抓取搜索结果内容
- **特性**:
  - 可选择特定输出格式(markdown, HTML, links, screenshots)
  - 自定义搜索参数(位置等)
  - 可以从搜索结果中检索内容
  - 控制结果数量和超时

### 3.2 API Endpoint

`POST https://api.firecrawl.dev/v2/search`

### 3.3 基本使用

```python
from firecrawl import Firecrawl

firecrawl = Firecrawl(api_key="fc-YOUR-API-KEY")

results = firecrawl.search(
    query="firecrawl",
    limit=3,
)
```

### 3.4 响应格式

```json
{
  "success": true,
  "data": {
    "web": [
      {
        "url": "https://www.firecrawl.dev/",
        "title": "Firecrawl - The Web Data API for AI",
        "description": "The web crawling, scraping, and search API for AI...",
        "position": 1
      }
    ],
    "images": [
      {
        "title": "Quickstart | Firecrawl",
        "imageUrl": "https://mintlify.s3.us-west-1.amazonaws.com/...",
        "imageWidth": 5814,
        "imageHeight": 1200,
        "url": "https://docs.firecrawl.dev/",
        "position": 1
      }
    ],
    "news": [
      {
        "title": "Y Combinator startup Firecrawl...",
        "url": "https://techcrunch.com/...",
        "snippet": "...",
        "date": "3 months ago",
        "position": 1
      }
    ]
  }
}
```

### 3.5 搜索结果类型

- `web`: 标准网络结果(默认)
- `news`: 新闻焦点结果
- `images`: 图像搜索结果

### 3.6 搜索类别

- `github`: 在 GitHub 仓库、代码、issues 和文档中搜索
- `research`: 搜索学术和研究网站(arXiv, Nature, IEEE, PubMed等)
- `pdf`: 搜索 PDF 文件

### 3.7 带内容抓取的搜索

```python
results = firecrawl.search(
    "firecrawl web scraping",
    limit=3,
    scrape_options={
        "formats": ["markdown", "links"]
    }
)
```

**响应包含抓取内容**:
```json
{
  "success": true,
  "data": [
    {
      "title": "Firecrawl - The Ultimate Web Scraping API",
      "url": "https://firecrawl.dev/",
      "markdown": "# Firecrawl\n\nThe Ultimate Web Scraping API...",
      "links": [
        "https://firecrawl.dev/pricing",
        "https://firecrawl.dev/docs"
      ],
      "metadata": {
        "title": "Firecrawl - The Ultimate Web Scraping API",
        "sourceURL": "https://firecrawl.dev/",
        "statusCode": 200
      }
    }
  ]
}
```

### 3.8 高级选项

**位置自定义**:
```python
results = firecrawl.search(
    "web scraping tools",
    limit=5,
    location="Germany"
)
```

**基于时间的搜索**:
```python
results = firecrawl.search(
    query="firecrawl",
    limit=5,
    tbs="qdr:d",  # 过去24小时
)
```

常用 `tbs` 值:
- `qdr:h` - 过去1小时
- `qdr:d` - 过去24小时
- `qdr:w` - 过去一周
- `qdr:m` - 过去一个月
- `qdr:y` - 过去一年

### 3.9 成本影响

- **基础搜索**: 每10个搜索结果 2 credits
- **启用抓取选项**时:
  - 基本抓取: 每个网页 1 credit
  - PDF 解析: 每个 PDF 页面 1 credit
  - Stealth 代理模式: 每个网页额外 4 credits
  - JSON 模式: 每个网页额外 4 credits

---

## 四、Firecrawl Scrape API

### 4.1 概述

- **功能**: 将网页转换为 markdown,适合 LLM 应用
- **特性**:
  - 处理动态内容: 动态网站、JS渲染站点、PDF、图像
  - 输出 markdown、结构化数据、截图或 HTML
  - 管理复杂性: 代理、缓存、速率限制、JS阻止的内容

### 4.2 API Endpoint

`POST https://api.firecrawl.dev/v2/scrape`

### 4.3 基本使用

```python
from firecrawl import Firecrawl

firecrawl = Firecrawl(api_key="fc-YOUR-API-KEY")

doc = firecrawl.scrape("https://firecrawl.dev", formats=["markdown", "html"])
```

### 4.4 响应格式

```json
{
  "success": true,
  "data": {
    "markdown": "Launch Week I is here! [See our Day 2 Release 🚀]...",
    "html": "<!DOCTYPE html><html lang=\"en\" class=\"light\"...",
    "metadata": {
      "title": "Home - Firecrawl",
      "description": "Firecrawl crawls and converts any website into clean markdown.",
      "language": "en",
      "keywords": "Firecrawl,Markdown,Data,Mendable,Langchain",
      "sourceURL": "https://firecrawl.dev",
      "statusCode": 200
    }
  }
}
```

### 4.5 抓取格式

支持的输出格式:
- `markdown` - Markdown 格式
- `summary` - 摘要
- `html` - HTML(有修改)
- `rawHtml` - 原始 HTML(无修改)
- `screenshot` - 截图(支持 `fullPage`, `quality`, `viewport` 选项)
- `links` - 链接列表
- `json` - 结构化输出
- `images` - 从页面提取所有图像 URL
- `branding` - 提取品牌标识和设计系统

### 4.6 提取结构化数据

```python
from firecrawl import Firecrawl
from pydantic import BaseModel

class CompanyInfo(BaseModel):
    company_mission: str
    supports_sso: bool
    is_open_source: bool

result = firecrawl.scrape(
    'https://firecrawl.dev',
    formats=[{
      "type": "json",
      "schema": CompanyInfo.model_json_schema()
    }]
)
```

**响应**:
```json
{
  "success": true,
  "data": {
    "json": {
      "company_mission": "AI-powered web scraping and data extraction",
      "supports_sso": true,
      "is_open_source": true
    }
  }
}
```

### 4.7 无 Schema 提取

```python
result = firecrawl.scrape(
    'https://firecrawl.dev',
    formats=[{
      "type": "json",
      "prompt": "Extract the company mission from the page."
    }]
)
```

### 4.8 页面交互 (Actions)

```python
doc = firecrawl.scrape(
    url="https://example.com/login",
    formats=["markdown"],
    actions=[
        {"type": "write", "text": "john@example.com"},
        {"type": "press", "key": "Tab"},
        {"type": "write", "text": "secret"},
        {"type": "click", "selector": 'button[type="submit"]'},
        {"type": "wait", "milliseconds": 1500},
        {"type": "screenshot", "fullPage": True},
    ],
)
```

### 4.9 位置和语言

```python
doc = firecrawl.scrape('https://example.com',
    formats=['markdown'],
    location={
        'country': 'US',
        'languages': ['en']
    }
)
```

### 4.10 缓存和 maxAge

```python
# 强制新鲜内容
doc = firecrawl.scrape(url='https://example.com', maxAge=0, formats=['markdown'])

# 使用 10 分钟缓存窗口
doc = firecrawl.scrape(url='https://example.com', maxAge=600000, formats=['markdown'])
```

- **默认新鲜度窗口**: `maxAge = 172800000` ms (2天)
- **性能提升**: 当数据不需要超新鲜时,可以将抓取速度提高 5 倍
- **总是获取新鲜内容**: 设置 `maxAge` 为 `0`
- **避免存储**: 设置 `storeInCache` 为 `false`

### 4.11 批量抓取多个 URL

```python
job = firecrawl.batch_scrape([
    "https://firecrawl.dev",
    "https://docs.firecrawl.dev",
], formats=["markdown"], poll_interval=2, wait_timeout=120)
```

### 4.12 成本

- **基本抓取**: 每个网页 1 credit
- **PDF 解析**: 每个 PDF 页面 1 credit
- **Stealth 代理模式**: 每个网页额外 4 credits
- **JSON 模式**: 每个网页额外 4 credits

---

## 五、集成对照分析

### 5.1 Web Search 功能对应

| Anthropic Web Search | Firecrawl Search | 对应关系 |
|---------------------|------------------|----------|
| `query` 参数 | `query` 参数 | ✅ 完全对应 |
| `max_uses` | `limit` | ✅ 功能相似,语义略有不同 |
| `allowed_domains` / `blocked_domains` | 无直接对应 | ⚠️ 需要后处理过滤 |
| `user_location` | `location` 参数 | ✅ 功能相似 |
| 返回 `encrypted_content` | 返回 `markdown` / `html` | ⚠️ 格式不同 |
| 自动引用 `citations` | 无自动引用 | ⚠️ 需要手动构建引用 |

### 5.2 Web Fetch 功能对应

| Anthropic Web Fetch | Firecrawl Scrape | 对应关系 |
|--------------------|------------------|----------|
| `url` 参数 | `url` 参数 | ✅ 完全对应 |
| `max_uses` | 批量抓取的 URL 数量 | ✅ 功能相似 |
| `allowed_domains` / `blocked_domains` | 无直接对应 | ⚠️ 需要前置过滤 |
| `citations.enabled` | 无自动引用 | ⚠️ 需要手动构建引用 |
| `max_content_tokens` | 无直接限制 | ⚠️ 需要后处理截断 |
| 返回 `document` 类型 | 返回多种格式 | ✅ 可配置 `formats` |
| PDF base64 编码 | 支持 PDF 解析 | ✅ Firecrawl 可提取文本 |

### 5.3 关键差异

1. **响应格式结构**:
   - Anthropic: 使用 `server_tool_use` 和特定的结果类型
   - Firecrawl: 直接返回内容和元数据

2. **引用机制**:
   - Anthropic: 内置自动引用,带加密索引
   - Firecrawl: 无内置引用,需要手动构建

3. **内容加密**:
   - Anthropic: 使用 `encrypted_content` 和 `encrypted_index`
   - Firecrawl: 明文内容

4. **URL 验证**:
   - Anthropic Web Fetch: 严格的 URL 验证(必须在对话历史中)
   - Firecrawl: 无此限制

5. **定价模型**:
   - Anthropic Web Search: $10/1000 次搜索 + token 成本
   - Anthropic Web Fetch: 仅 token 成本
   - Firecrawl: 基于 credits 的定价

---

## 六、集成技术挑战

### 6.1 请求格式转换

需要将 Anthropic 的 tool 格式转换为 Firecrawl API 调用:

```typescript
// Anthropic 请求
{
  "tools": [{
    "type": "web_search_20250305",
    "name": "web_search",
    "max_uses": 5
  }]
}

// 转换为 Firecrawl
firecrawl.search({
  query: extractedQuery,
  limit: toolDef.max_uses || 5,
  scrape_options: { formats: ["markdown"] }
})
```

### 6.2 响应格式转换

需要将 Firecrawl 的响应转换为 Anthropic 的格式:

```typescript
// Firecrawl 响应
{
  "data": {
    "web": [{
      "url": "...",
      "title": "...",
      "description": "...",
      "markdown": "..."
    }]
  }
}

// 转换为 Anthropic 格式
{
  "type": "web_search_tool_result",
  "tool_use_id": "srvtoolu_xxx",
  "content": [{
    "type": "web_search_result",
    "url": "...",
    "title": "...",
    "encrypted_content": base64Encode(markdown)
  }]
}
```

### 6.3 引用构建

Anthropric 需要引用信息,但 Firecrawl 不提供。需要:
1. 从 Firecrawl 的 markdown 内容中提取关键片段
2. 构建 `citations` 数组
3. 生成 `encrypted_index` (可以用 base64 编码标识)

### 6.4 多轮对话支持

Anthropric 使用 `encrypted_content` 在多轮对话中传递搜索结果。集成方案需要:
1. 缓存 Firecrawl 的完整响应
2. 生成唯一的加密索引
3. 在后续请求中解码并使用缓存的内容

### 6.5 错误映射

需要将 Firecrawl 的错误映射到 Anthropric 的错误码:

| Firecrawl 错误 | Anthropic 错误码 |
|---------------|------------------|
| 速率限制 | `too_many_requests` |
| 无效输入 | `invalid_input` |
| URL 访问失败 | `unavailable` |
| 超时 | `unavailable` |

### 6.6 流式响应

Anthropric 支持 SSE 流式响应,需要:
1. 在 Firecrawl 请求完成前发送进度事件
2. 按 Anthropic 的流式格式发送 `content_block_start`/`delta`/`stop` 事件
3. 处理 `pause_turn` 场景

---

## 七、TypeScript/JavaScript SDK 使用

### 7.1 Anthropic TypeScript SDK

#### 安装

```bash
npm install @anthropic-ai/sdk
```

#### 基本使用

```typescript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env['ANTHROPIC_API_KEY'],
});

const message = await client.messages.create({
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello, Claude' }],
  model: 'claude-sonnet-4-5-20250929',
});
```

#### Web Search 使用

```typescript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

const response = await client.messages.create({
  model: 'claude-sonnet-4-5',
  max_tokens: 1024,
  messages: [{
    role: 'user',
    content: 'What is the current weather in NYC?'
  }],
  tools: [{
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 5
  }]
});

console.log(response);
```

#### Web Fetch 使用

```typescript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

const response = await client.messages.create({
  model: 'claude-sonnet-4-5',
  max_tokens: 1024,
  messages: [{
    role: 'user',
    content: 'Please analyze https://docs.firecrawl.dev/features/scrape'
  }],
  tools: [{
    type: 'web_fetch_20250910',
    name: 'web_fetch',
    max_uses: 10,
    citations: { enabled: true }
  }]
},{
  headers: {
    'anthropic-beta': 'web-fetch-2025-09-10'
  }
});
```

#### 流式响应

```typescript
const stream = await client.messages.create({
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello, Claude' }],
  model: 'claude-sonnet-4-5',
  stream: true,
});

for await (const messageStreamEvent of stream) {
  console.log(messageStreamEvent.type);
}
```

#### Tool Runner (简化 Tool Use 处理)

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

const anthropic = new Anthropic();

const weatherTool = betaZodTool({
  name: 'get_weather',
  inputSchema: z.object({
    location: z.string(),
  }),
  description: 'Get the current weather in a given location',
  run: (input) => {
    return `The weather in ${input.location} is foggy and 60°F`;
  },
});

const finalMessage = await anthropic.beta.messages.toolRunner({
  model: 'claude-3-5-sonnet-20241022',
  max_tokens: 1000,
  messages: [{ role: 'user', content: 'What is the weather in San Francisco?' }],
  tools: [weatherTool],
});
```

### 7.2 Firecrawl Node SDK

#### 安装

```bash
npm install @mendable/firecrawl-js
```

#### 基本使用

```typescript
import Firecrawl from '@mendable/firecrawl-js';

const firecrawl = new Firecrawl({ apiKey: 'fc-YOUR-API-KEY' });

// Scrape a website
const scrapeResponse = await firecrawl.scrape('https://firecrawl.dev', {
  formats: ['markdown', 'html'],
});

console.log(scrapeResponse);

// Crawl a website
const crawlResponse = await firecrawl.crawl('https://firecrawl.dev', {
  limit: 100,
  scrapeOptions: {
    formats: ['markdown', 'html'],
  }
});

console.log(crawlResponse);
```

#### Search API

```typescript
import Firecrawl from '@mendable/firecrawl-js';

const firecrawl = new Firecrawl({ apiKey: 'fc-YOUR-API-KEY' });

const results = await firecrawl.search({
  query: 'firecrawl',
  limit: 3,
});

console.log(results);
```

#### 带内容抓取的搜索

```typescript
const results = await firecrawl.search({
  query: 'firecrawl web scraping',
  limit: 3,
  scrapeOptions: {
    formats: ['markdown', 'links']
  }
});
```

#### Scrape with Options

```typescript
const doc = await firecrawl.scrape('https://firecrawl.dev', {
  formats: ['markdown', 'html'],
  location: {
    country: 'US',
    languages: ['en']
  },
  maxAge: 0  // 强制新鲜内容
});
```

#### 批量抓取

```typescript
const job = await firecrawl.batchScrape([
  'https://firecrawl.dev',
  'https://docs.firecrawl.dev',
], {
  formats: ['markdown'],
  pollInterval: 2,
  waitTimeout: 120
});

console.log(job);
```

### 7.3 集成示例代码

#### 拦截 Web Search Tool

```typescript
// tool_interceptor.ts
import Anthropic from '@anthropic-ai/sdk';
import Firecrawl from '@mendable/firecrawl-js';

interface WebSearchToolDef {
  type: 'web_search_20250305';
  name: 'web_search';
  max_uses?: number;
  allowed_domains?: string[];
  blocked_domains?: string[];
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: {
    query: string;
  };
}

async function interceptWebSearch(
  toolDef: WebSearchToolDef,
  toolUse: ToolUseBlock,
  firecrawl: Firecrawl
): Promise<any> {
  // 1. 调用 Firecrawl Search
  const searchResults = await firecrawl.search({
    query: toolUse.input.query,
    limit: toolDef.max_uses || 5,
    scrapeOptions: {
      formats: ['markdown']
    }
  });

  // 2. 转换为 Anthropic 格式
  const anthropicResults = searchResults.data.web.map(item => {
    // 生成加密内容
    const encryptedContent = Buffer.from(
      JSON.stringify({
        url: item.url,
        content: item.markdown || item.description
      })
    ).toString('base64');

    return {
      type: 'web_search_result',
      url: item.url,
      title: item.title,
      encrypted_content: encryptedContent,
      page_age: 'Recent'
    };
  });

  // 3. 返回 Anthropic 格式结果
  return {
    type: 'web_search_tool_result',
    tool_use_id: toolUse.id,
    content: anthropicResults
  };
}

// 使用示例
const firecrawl = new Firecrawl({ apiKey: 'fc-YOUR-API-KEY' });

const toolDef: WebSearchToolDef = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 5
};

const toolUse: ToolUseBlock = {
  type: 'tool_use',
  id: 'toolu_01234567890',
  name: 'web_search',
  input: {
    query: 'what is firecrawl'
  }
};

const result = await interceptWebSearch(toolDef, toolUse, firecrawl);
console.log(result);
```

#### 拦截 Web Fetch Tool

```typescript
// web_fetch_interceptor.ts
import Anthropic from '@anthropic-ai/sdk';
import Firecrawl from '@mendable/firecrawl-js';

interface WebFetchToolDef {
  type: 'web_fetch_20250910';
  name: 'web_fetch';
  max_uses?: number;
  allowed_domains?: string[];
  blocked_domains?: string[];
  citations?: { enabled: boolean };
  max_content_tokens?: number;
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: {
    url: string;
  };
}

async function interceptWebFetch(
  toolDef: WebFetchToolDef,
  toolUse: ToolUseBlock,
  firecrawl: Firecrawl
): Promise<any> {
  // 1. 调用 Firecrawl Scrape
  const scrapeResult = await firecrawl.scrape(toolUse.input.url, {
    formats: ['markdown'],
    maxAge: 0
  });

  // 2. 转换为 Anthropic 格式
  const content = {
    type: 'document',
    source: {
      type: 'text',
      media_type: 'text/plain',
      data: scrapeResult.data.markdown
    },
    title: scrapeResult.data.metadata?.title || 'Document',
    citations: toolDef.citations
  };

  // 3. 返回 Anthropic 格式结果
  return {
    type: 'web_fetch_tool_result',
    tool_use_id: toolUse.id,
    content: {
      type: 'web_fetch_result',
      url: toolUse.input.url,
      content: content,
      retrieved_at: new Date().toISOString()
    }
  };
}

// 使用示例
const firecrawl = new Firecrawl({ apiKey: 'fc-YOUR-API-KEY' });

const toolDef: WebFetchToolDef = {
  type: 'web_fetch_20250910',
  name: 'web_fetch',
  citations: { enabled: true }
};

const toolUse: ToolUseBlock = {
  type: 'tool_use',
  id: 'toolu_01234567890',
  name: 'web_fetch',
  input: {
    url: 'https://docs.firecrawl.dev/features/scrape'
  }
};

const result = await interceptWebFetch(toolDef, toolUse, firecrawl);
console.log(result);
```

#### 完整集成流程

```typescript
// proxy_handler.ts
import Anthropic from '@anthropic-ai/sdk';
import Firecrawl from '@mendable/firecrawl-js';

class ToolInterceptor {
  private anthropic: Anthropic;
  private firecrawl: Firecrawl;

  constructor(anthropicKey: string, firecrawlKey: string) {
    this.anthropic = new Anthropic({ apiKey: anthropicKey });
    this.firecrawl = new Firecrawl({ apiKey: firecrawlKey });
  }

  async handleRequest(request: Anthropic.MessageCreateParams): Promise<Anthropic.Message> {
    // 1. 检查是否有需要拦截的 tools
    const needsIntercept = request.tools?.some(tool => 
      tool.type === 'web_search_20250305' || 
      tool.type === 'web_fetch_20250910'
    );

    if (!needsIntercept) {
      // 直接转发到上游
      return await this.anthropic.messages.create(request);
    }

    // 2. 先获取 Claude 的初始响应
    const response = await this.anthropic.messages.create(request);

    // 3. 检查是否有 tool_use
    const toolUseBlocks = response.content.filter(
      block => block.type === 'tool_use'
    );

    if (toolUseBlocks.length === 0) {
      return response;
    }

    // 4. 处理每个 tool_use
    const toolResults = [];
    for (const toolUse of toolUseBlocks) {
      if (toolUse.name === 'web_search') {
        const result = await this.handleWebSearch(toolUse);
        toolResults.push(result);
      } else if (toolUse.name === 'web_fetch') {
        const result = await this.handleWebFetch(toolUse);
        toolResults.push(result);
      }
    }

    // 5. 继续对话,传入 tool results
    const continuedResponse = await this.anthropic.messages.create({
      ...request,
      messages: [
        ...request.messages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: toolResults }
      ]
    });

    return continuedResponse;
  }

  private async handleWebSearch(toolUse: any): Promise<any> {
    const searchResults = await this.firecrawl.search({
      query: toolUse.input.query,
      limit: 5,
      scrapeOptions: { formats: ['markdown'] }
    });

    const results = searchResults.data.web.map(item => ({
      type: 'web_search_result',
      url: item.url,
      title: item.title,
      encrypted_content: Buffer.from(item.markdown || '').toString('base64'),
      page_age: 'Recent'
    }));

    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: [{
        type: 'web_search_tool_result',
        tool_use_id: toolUse.id,
        content: results
      }]
    };
  }

  private async handleWebFetch(toolUse: any): Promise<any> {
    const scrapeResult = await this.firecrawl.scrape(toolUse.input.url, {
      formats: ['markdown'],
      maxAge: 0
    });

    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: [{
        type: 'web_fetch_tool_result',
        tool_use_id: toolUse.id,
        content: {
          type: 'web_fetch_result',
          url: toolUse.input.url,
          content: {
            type: 'document',
            source: {
              type: 'text',
              media_type: 'text/plain',
              data: scrapeResult.data.markdown
            },
            title: scrapeResult.data.metadata?.title || 'Document'
          },
          retrieved_at: new Date().toISOString()
        }
      }]
    };
  }
}

// 使用示例
const interceptor = new ToolInterceptor(
  process.env.ANTHROPIC_API_KEY!,
  process.env.FIRECRAWL_API_KEY!
);

const request: Anthropic.MessageCreateParams = {
  model: 'claude-sonnet-4-5',
  max_tokens: 1024,
  messages: [{
    role: 'user',
    content: 'What is Firecrawl? Please search the web.'
  }],
  tools: [{
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 5
  }]
};

const response = await interceptor.handleRequest(request);
console.log(response);
```

---

## 八、参考资源

### 官方文档

- [Anthropic Web Search Tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)
- [Anthropic Web Fetch Tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool)
- [Anthropic Tool Use Implementation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use)
- [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript)
- [Firecrawl Search API](https://docs.firecrawl.dev/features/search)
- [Firecrawl Scrape API](https://docs.firecrawl.dev/features/scrape)
- [Firecrawl Node SDK](https://docs.firecrawl.dev/sdks/node)
- [Firecrawl API Reference](https://docs.firecrawl.dev/api-reference/v2-introduction)

### NPM Packages

- [@anthropic-ai/sdk](https://www.npmjs.com/package/@anthropic-ai/sdk)
- [@mendable/firecrawl-js](https://www.npmjs.com/package/@mendable/firecrawl-js)

### API Endpoints

- Anthropic Messages API: `https://api.anthropic.com/v1/messages`
- Firecrawl Search: `https://api.firecrawl.dev/v2/search`
- Firecrawl Scrape: `https://api.firecrawl.dev/v2/scrape`
