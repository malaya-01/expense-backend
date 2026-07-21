import { Injectable } from '@nestjs/common';

export type AiWebSource = {
  label: string;
  href: string;
  snippet: string;
  domain: string;
  image_url?: string;
  source_type: 'web';
};

@Injectable()
export class AiWebSearchService {
  get available() {
    return Boolean(process.env.TAVILY_API_KEY?.trim());
  }

  async search(query: string): Promise<{
    sources: AiWebSource[];
    context: Array<{
      title: string;
      url: string;
      content: string;
      published_date?: string;
    }>;
  }> {
    const apiKey = process.env.TAVILY_API_KEY?.trim();
    if (!apiKey) return { sources: [], context: [] };

    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(12_000),
      body: JSON.stringify({
        api_key: apiKey,
        query: this.publicQuery(query),
        search_depth: 'advanced',
        topic: 'general',
        max_results: 6,
        include_answer: false,
        include_images: true,
        include_raw_content: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Web search failed (${response.status})`);
    }

    const data = (await response.json()) as {
      results?: Array<{
        title?: string;
        url?: string;
        content?: string;
        published_date?: string;
      }>;
      images?: Array<string | { url?: string; description?: string }>;
    };
    const images = (data.images || [])
      .map((image) => (typeof image === 'string' ? image : image.url || ''))
      .filter((url) => /^https:\/\//i.test(url))
      .slice(0, 6);

    const results = (data.results || [])
      .filter((result) => result.title && /^https:\/\//i.test(result.url || ''))
      .slice(0, 6);

    return {
      sources: results.map((result, index) => ({
        label: String(result.title).slice(0, 180),
        href: String(result.url),
        snippet: String(result.content || '').slice(0, 320),
        domain: this.domain(String(result.url)),
        image_url: images[index],
        source_type: 'web' as const,
      })),
      context: results.map((result) => ({
        title: String(result.title),
        url: String(result.url),
        content: String(result.content || '').slice(0, 1800),
        published_date: result.published_date,
      })),
    };
  }

  shouldSearchAutomatically(query: string) {
    return /\b(latest|current|today|recent|news|market|interest rate|inflation|tax law|regulation|exchange rate|stock price|research online|search (?:the )?web|web search)\b/i.test(
      query,
    );
  }

  private publicQuery(query: string) {
    return query
      .replace(
        /\b(?:my|mine|i have|i owe|my salary|my income|my balance|my account)\b/gi,
        'personal finance',
      )
      .replace(/\b(?:[$€£₹]\s*)?\d[\d,]*(?:\.\d+)?\b/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
  }

  private domain(url: string) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return 'Web source';
    }
  }
}
