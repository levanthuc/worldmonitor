import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { Panel } from './Panel';
import { postProcessAnalystHtml } from '@/utils/analyst-markdown';
import { yieldToMain } from '@/utils/after-paint';
import {
  h,
  replaceChildren,
  setTrustedHtml,
  trustedHtml,
  type TrustedHtml,
} from '@/utils/dom-utils';
import {
  GOLD_ANALYST_SETTINGS_CHANGED,
  getGoldAnalystSettings,
  type GoldAnalystReadiness,
} from '@/services/gold-analyst-settings';

const API_URL = '/api/gold-analyst';
const MAX_HISTORY_MESSAGES = 12;

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface Citation {
  id: string;
  label: string;
  url?: string;
  asOf: string;
  kind: 'market' | 'macro' | 'calendar' | 'positioning' | 'flow' | 'technical' | 'sentiment' | 'geopolitical' | 'news';
}

interface GoldAnalystObservation {
  id: string;
  category: string;
  label: string;
  value: string;
  source: string;
  asOf: string;
  baseline?: string;
  freshness: 'live' | 'recent' | 'stale';
}

interface GoldAnalystMeta {
  citations: Citation[];
  observations: GoldAnalystObservation[];
  coverage: Array<{
    id: string;
    label: string;
    status: 'available' | 'partial' | 'unavailable';
    observationIds: string[];
    note: string;
  }>;
  sources: string[];
  degraded: boolean;
  readiness: GoldAnalystReadiness;
  asOf: string;
  provider: string;
  model: string;
}

interface GoldAnalystDataExportResponse {
  mode: 'data_export';
  export: {
    format: 'worldmonitor-gold-silver-evidence-v1';
    generatedAt: string;
    observationCount: number;
    citationCount: number;
    prompt: string;
  };
  meta: GoldAnalystMeta;
}

const QUICK_ACTIONS = [
  {
    label: 'Xu hướng 24h',
    query: 'Phân tích xu hướng Vàng trong 24h tới dựa trên dữ liệu vĩ mô hiện tại. Hãy đưa ra kịch bản cơ sở, tăng giá và giảm giá, kèm trích dẫn dữ liệu.',
  },
  {
    label: 'Động lực chính',
    query: 'Đâu là các động lực đang tác động mạnh nhất tới giá vàng lúc này?',
  },
  {
    label: 'Kịch bản rủi ro',
    query: 'Lập ba kịch bản tăng, cơ sở và giảm cho vàng trong 24 giờ tới, kèm điều kiện xác nhận.',
  },
] as const;

const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'strong', 'em', 'b', 'i', 'br', 'hr',
    'ul', 'ol', 'li', 'code', 'pre',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'div', 'span',
  ],
  ALLOWED_ATTR: ['class'],
  ALLOW_DATA_ATTR: false,
};

function renderMarkdown(raw: string): TrustedHtml {
  const sanitized = DOMPurify.sanitize(marked.parse(raw) as string, PURIFY_CONFIG);
  return trustedHtml(
    postProcessAnalystHtml(sanitized as string),
    'Gold Analyst markdown is sanitized before insertion',
  );
}

function safeExternalUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function formatAsOf(raw: string): string {
  if (!raw) return 'time unavailable';
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return raw;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

export class GoldAnalystPanel extends Panel {
  private history: ChatMessage[] = [];
  private streamAbort: AbortController | null = null;
  private isStreaming = false;
  private messagesEl!: HTMLElement;
  private inputEl: HTMLTextAreaElement | null = null;
  private statusTextEl: HTMLElement | null = null;
  private dataExportEl: HTMLElement | null = null;
  private dataExportPrompt = '';
  private dataExportLoading = false;
  private listenersAttached = false;
  private readonly settingsChanged = () => this.updateStatusText();

  constructor() {
    super({
      id: 'gold-analyst',
      title: 'Gold Analyst',
      defaultRowSpan: 2,
      infoTooltip: '<strong>Gold / Silver Analyst</strong><br>Trợ lý AI chỉ dùng snapshot hệ thống có kiểm định: giá và kỹ thuật Vàng/Bạc, DXY/lợi suất/CPI, CFTC và vị thế 24/7, ETF, stress/tâm lý, tin tức, xung đột, trừng phạt, bất ổn và prediction markets. Mở “Dữ liệu đã cung cấp cho AI” để kiểm tra coverage từng panel.',
    });
    this.buildUI();
  }

  private buildUI(): void {
    const wrapper = h('div', { className: 'chat-analyst-wrapper gold-analyst-wrapper' });
    const statusText = h('span');
    this.statusTextEl = statusText;
    const statusBar = h('div', { className: 'gold-analyst-status' },
      h('span', { className: 'gold-analyst-status-dot' }),
      statusText,
    );
    const dataExport = h('section', {
      className: 'gold-analyst-data-export',
      'aria-label': 'Gold and silver analysis data export',
    },
    h('div', { className: 'gold-analyst-data-export-header' },
      h('div', {},
        h('div', { className: 'chat-msg-label' }, 'GOLD & SILVER DATA'),
        h('div', { className: 'gold-analyst-data-export-copy' }, 'Đang tải snapshot dữ liệu đã kiểm định…'),
      ),
      h('div', { className: 'gold-analyst-data-export-actions' },
        h('button', {
          className: 'chat-quick-btn',
          dataset: { exportAction: 'refresh' },
          type: 'button',
          title: 'Làm mới snapshot dữ liệu',
        }, '↻ Làm mới'),
        h('button', {
          className: 'chat-quick-btn',
          dataset: { exportAction: 'copy' },
          type: 'button',
          disabled: true,
          title: 'Sao chép dữ liệu và hướng dẫn phân tích cho AI bên ngoài',
        }, '⧉ Sao chép dữ liệu'),
      ),
    ));
    this.dataExportEl = dataExport;
    const messages = h('div', { className: 'chat-analyst-messages gold-analyst-messages' });
    this.messagesEl = messages;

    const quickBar = h('div', { className: 'chat-analyst-quick' });
    for (const action of QUICK_ACTIONS) {
      quickBar.appendChild(h('button', {
        className: 'chat-quick-btn',
        dataset: { quickAction: action.query },
        type: 'button',
      }, action.label));
    }

    const inputRow = h('div', { className: 'chat-analyst-input-row' });
    const textarea = document.createElement('textarea');
    textarea.className = 'chat-analyst-input';
    textarea.placeholder = 'Hỏi về xu hướng vàng, vĩ mô, dòng tiền…';
    textarea.rows = 2;
    this.inputEl = textarea;
    inputRow.appendChild(textarea);
    inputRow.appendChild(h('button', {
      className: 'chat-analyst-clear',
      dataset: { action: 'clear' },
      type: 'button',
      title: 'Xóa hội thoại',
    }, '✕'));
    inputRow.appendChild(h('button', {
      className: 'chat-analyst-send',
      dataset: { action: 'send' },
      type: 'button',
      title: 'Gửi',
    }, '▶'));

    wrapper.appendChild(statusBar);
    wrapper.appendChild(dataExport);
    wrapper.appendChild(messages);
    wrapper.appendChild(quickBar);
    wrapper.appendChild(inputRow);
    replaceChildren(this.content, wrapper);

    this.showWelcome();
    this.attachListeners();
    this.updateStatusText();
    void this.loadDataExport();
  }

  private updateStatusText(): void {
    if (!this.statusTextEl) return;
    const settings = getGoldAnalystSettings();
    const provider = settings.provider === 'auto'
      ? 'Auto'
      : settings.provider === 'openai'
        ? 'OpenAI'
        : settings.provider === 'gemini'
          ? 'Gemini'
          : 'Groq';
    this.statusTextEl.textContent = `Data Export độc lập · AI tùy chọn: ${provider} · ${settings.model || settings.mode}`;
  }

  private attachListeners(): void {
    if (this.listenersAttached) return;
    this.listenersAttached = true;
    window.addEventListener(GOLD_ANALYST_SETTINGS_CHANGED, this.settingsChanged);

    this.content.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const quick = target.closest('[data-quick-action]') as HTMLElement | null;
      if (quick?.dataset.quickAction) {
        void this.send(quick.dataset.quickAction);
        return;
      }
      const exportAction = target.closest('[data-export-action]') as HTMLElement | null;
      if (exportAction?.dataset.exportAction === 'refresh') {
        void this.loadDataExport(true);
        return;
      }
      if (exportAction?.dataset.exportAction === 'copy') {
        void this.copyDataExport();
        return;
      }
      const action = target.closest('[data-action]') as HTMLElement | null;
      if (action?.dataset.action === 'send') this.sendFromInput();
      if (action?.dataset.action === 'clear') this.clear();
    });

    this.content.addEventListener('keydown', (event) => {
      if (event.target !== this.inputEl) return;
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.sendFromInput();
      }
    });
  }

  private showWelcome(): void {
    const bubble = h('div', { className: 'chat-msg chat-msg-assistant' },
      h('div', { className: 'chat-msg-label' }, 'GOLD ANALYST'),
      h('div', { className: 'chat-msg-body' },
        'Sẵn sàng. Tôi chỉ phân tích bằng snapshot dữ liệu WorldMonitor hiện có, kèm mã [D…]/[N…] và bảng coverage từng panel.',
      ),
    );
    replaceChildren(this.messagesEl, bubble);
  }

  private setControlsDisabled(disabled: boolean): void {
    const sendButton = this.content.querySelector('[data-action="send"]') as HTMLButtonElement | null;
    if (sendButton) sendButton.disabled = disabled;
    if (this.inputEl) this.inputEl.disabled = disabled;
  }

  private sendFromInput(): void {
    if (!this.inputEl || this.isStreaming) return;
    const query = this.inputEl.value.trim();
    if (!query) return;
    this.inputEl.value = '';
    void this.send(query);
  }

  private appendUserMessage(content: string): void {
    this.messagesEl.appendChild(h('div', { className: 'chat-msg chat-msg-user' },
      h('div', { className: 'chat-msg-label' }, 'YOU'),
      h('div', { className: 'chat-msg-body' }, content),
    ));
    this.scrollToBottom();
  }

  private appendStreamingBubble(): { bubble: HTMLElement; body: HTMLElement } {
    const body = h('div', { className: 'chat-msg-body' },
      h('span', { className: 'chat-streaming-dot' }),
    );
    const bubble = h('div', { className: 'chat-msg chat-msg-assistant chat-msg-streaming' },
      h('div', { className: 'chat-msg-label' }, 'GOLD ANALYST'),
      body,
    );
    this.messagesEl.appendChild(bubble);
    this.scrollToBottom();
    return { bubble, body };
  }

  private setDataExportActionState(copyEnabled: boolean, refreshing: boolean): void {
    const refresh = this.content.querySelector('[data-export-action="refresh"]') as HTMLButtonElement | null;
    const copy = this.content.querySelector('[data-export-action="copy"]') as HTMLButtonElement | null;
    if (refresh) refresh.disabled = refreshing;
    if (copy) copy.disabled = !copyEnabled;
  }

  private async loadDataExport(force = false): Promise<void> {
    if (this.dataExportLoading) return;
    this.dataExportLoading = true;
    this.setDataExportActionState(Boolean(this.dataExportPrompt), true);
    const summary = this.dataExportEl?.querySelector('.gold-analyst-data-export-copy');
    if (summary) summary.textContent = force
      ? 'Đang làm mới snapshot dữ liệu…'
      : 'Đang tải snapshot dữ liệu đã kiểm định…';

    try {
      const response = await fetch(`${API_URL}?mode=export`, {
        headers: { Accept: 'application/json' },
        // Data Export is explicitly public and has no user/provider state.
        // It stays available even if an unrelated anonymous-session refresh
        // is temporarily in its cooldown state.
        credentials: 'omit',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as GoldAnalystDataExportResponse;
      if (payload.mode !== 'data_export' || !payload.export?.prompt || !payload.meta) {
        throw new Error('Invalid data export response');
      }
      this.dataExportPrompt = payload.export.prompt;
      this.renderDataExport(payload);
      this.setDataExportActionState(true, false);
    } catch {
      this.dataExportPrompt = '';
      if (summary) {
        summary.textContent = 'Không tải được snapshot dữ liệu. Hãy thử Làm mới; không có AI nào được gọi.';
      }
      this.setDataExportActionState(false, false);
    } finally {
      this.dataExportLoading = false;
    }
  }

  private renderDataExport(payload: GoldAnalystDataExportResponse): void {
    if (!this.dataExportEl) return;
    const summary = h('div', { className: 'gold-analyst-data-export-copy' },
      `${payload.export.observationCount} dữ liệu · ${payload.export.citationCount} nguồn · `
      + `snapshot ${formatAsOf(payload.export.generatedAt)} · không gọi AI.`,
    );
    const header = h('div', { className: 'gold-analyst-data-export-header' },
      h('div', {},
        h('div', { className: 'chat-msg-label' }, 'GOLD & SILVER DATA'),
        summary,
      ),
      h('div', { className: 'gold-analyst-data-export-actions' },
        h('button', {
          className: 'chat-quick-btn',
          dataset: { exportAction: 'refresh' },
          type: 'button',
          title: 'Làm mới snapshot dữ liệu',
        }, '↻ Làm mới'),
        h('button', {
          className: 'chat-quick-btn',
          dataset: { exportAction: 'copy' },
          type: 'button',
          title: 'Sao chép dữ liệu và hướng dẫn phân tích cho AI bên ngoài',
        }, '⧉ Sao chép dữ liệu'),
      ),
    );
    const body = h('div', { className: 'gold-analyst-data-export-body' },
      h('div', { className: 'gold-analyst-evidence-readiness' },
        `Readiness ${payload.meta.readiness.score}/100 · ${payload.meta.readiness.level}. `
        + (payload.meta.readiness.missing.length
          ? `Thiếu: ${payload.meta.readiness.missing.join(', ')}`
          : 'Không thiếu nhóm dữ liệu bắt buộc.'),
      ),
      h('div', { className: 'gold-analyst-data-export-hint' },
        'Nút sao chép gồm toàn bộ dữ liệu, nguồn, độ mới, coverage và quy tắc để ChatGPT/Claude/Gemini chỉ phân tích theo snapshot này.',
      ),
      h('a', {
        className: 'gold-analyst-data-export-source-link',
        href: 'https://github.com/levanthuc/worldmonitor',
        target: '_blank',
        rel: 'noopener noreferrer',
      }, 'Mã nguồn phiên bản đang triển khai'),
    );
    body.appendChild(this.buildObservationsDetails(payload.meta));
    this.appendCitations(body, payload.meta, '');
    replaceChildren(this.dataExportEl, header, body);
  }

  private async copyDataExport(): Promise<void> {
    if (!this.dataExportPrompt) return;
    const copy = this.content.querySelector('[data-export-action="copy"]') as HTMLButtonElement | null;
    const originalText = copy?.textContent || '⧉ Sao chép dữ liệu';
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(this.dataExportPrompt);
      } else {
        const area = document.createElement('textarea');
        area.value = this.dataExportPrompt;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const copied = document.execCommand('copy');
        area.remove();
        if (!copied) throw new Error('Clipboard copy failed');
      }
      if (copy) {
        copy.textContent = '✓ Đã sao chép';
        window.setTimeout(() => {
          if (copy.isConnected) copy.textContent = originalText;
        }, 2_500);
      }
    } catch {
      if (copy) {
        copy.textContent = '⚠ Không sao chép được';
        window.setTimeout(() => {
          if (copy.isConnected) copy.textContent = originalText;
        }, 3_500);
      }
    }
  }

  private renderMeta(bubble: HTMLElement, meta: GoldAnalystMeta): void {
    const row = h('div', { className: 'chat-source-chips' });
    row.appendChild(h('span', { className: 'chat-source-chip' }, `${meta.provider} · ${meta.model}`));
    row.appendChild(h('span', { className: 'chat-source-chip' }, `As of ${formatAsOf(meta.asOf)}`));
    row.appendChild(h('span', {
      className: `chat-source-chip${meta.readiness.level === 'full' ? '' : ' chat-source-chip--warn'}`,
    }, `Data ${meta.readiness.score}/100 · ${meta.readiness.level}`));
    if (meta.degraded) {
      row.appendChild(h('span', {
        className: 'chat-source-chip chat-source-chip--warn',
      }, '⚠ partial data'));
    }
    const body = bubble.querySelector('.chat-msg-body');
    if (body) bubble.insertBefore(row, body);
  }

  private buildObservationsDetails(meta: GoldAnalystMeta): HTMLElement {
    const details = document.createElement('details');
    details.className = 'gold-analyst-citations gold-analyst-evidence';
    const summary = document.createElement('summary');
    summary.textContent = `Dữ liệu đã cung cấp cho AI (${meta.observations.length})`;
    details.appendChild(summary);

    const readiness = document.createElement('div');
    readiness.className = 'gold-analyst-evidence-readiness';
    readiness.textContent = `Readiness ${meta.readiness.score}/100 · ${meta.readiness.level}. `
      + (meta.readiness.missing.length
        ? `Thiếu: ${meta.readiness.missing.join(', ')}.`
        : 'Không thiếu nhóm dữ liệu bắt buộc.');
    details.appendChild(readiness);

    if (meta.coverage?.length) {
      const coverageTitle = document.createElement('strong');
      coverageTitle.textContent = 'Coverage theo panel';
      details.appendChild(coverageTitle);
      const coverageList = document.createElement('ul');
      coverageList.className = 'gold-analyst-coverage-list';
      for (const coverage of meta.coverage) {
        const item = document.createElement('li');
        const evidence = coverage.observationIds.length
          ? ` · ${coverage.observationIds.map((id) => `[${id}]`).join(' ')}`
          : '';
        item.textContent = `${coverage.status === 'available' ? '✓' : coverage.status === 'partial' ? '◐' : '✕'} `
          + `${coverage.label}: ${coverage.note}${evidence}`;
        coverageList.appendChild(item);
      }
      details.appendChild(coverageList);
    }

    const list = document.createElement('ol');
    for (const observation of meta.observations) {
      const item = document.createElement('li');
      item.className = `gold-analyst-evidence-item is-${observation.freshness}`;
      const title = document.createElement('strong');
      title.textContent = `[${observation.id}] ${observation.label}: `;
      item.appendChild(title);
      item.appendChild(document.createTextNode(observation.value));
      item.appendChild(document.createElement('br'));
      const source = document.createElement('small');
      source.textContent = `${observation.source} · ${formatAsOf(observation.asOf)} · ${observation.freshness}`
        + (observation.baseline ? ` · ${observation.baseline}` : '');
      item.appendChild(source);
      list.appendChild(item);
    }
    details.appendChild(list);
    return details;
  }

  private renderObservations(bubble: HTMLElement, meta: GoldAnalystMeta): void {
    if (!meta.observations?.length) return;
    bubble.appendChild(this.buildObservationsDetails(meta));
  }

  private appendCitations(container: HTMLElement, meta: GoldAnalystMeta, answer: string): void {
    const cited = meta.citations.filter((citation) => answer.includes(`[${citation.id}]`));
    const citations = cited.length ? cited : meta.citations;
    if (!citations.length) return;

    const details = document.createElement('details');
    details.className = 'gold-analyst-citations';
    const summary = document.createElement('summary');
    summary.textContent = `Nguồn dữ liệu (${citations.length})`;
    details.appendChild(summary);

    const list = document.createElement('ol');
    for (const citation of citations) {
      const item = document.createElement('li');
      const id = document.createElement('strong');
      id.textContent = `[${citation.id}] `;
      item.appendChild(id);

      const url = safeExternalUrl(citation.url);
      if (url) {
        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer nofollow';
        link.textContent = citation.label;
        item.appendChild(link);
      } else {
        item.appendChild(document.createTextNode(citation.label));
      }
      item.appendChild(document.createTextNode(` · ${formatAsOf(citation.asOf)}`));
      list.appendChild(item);
    }
    details.appendChild(list);
    container.appendChild(details);
  }

  private renderCitations(bubble: HTMLElement, meta: GoldAnalystMeta, answer: string): void {
    this.appendCitations(bubble, meta, answer);
  }

  private async describeError(response: Response): Promise<string> {
    try {
      const body = await response.json() as { code?: string; error?: string; setup?: string };
      if (body.code === 'provider_key_missing') {
        return 'Chưa có AI provider khả dụng. Cấu hình key ở `.env.local`, khởi động lại WorldMonitor, rồi chọn provider trong Settings.';
      }
      if (body.code === 'gold_data_unavailable') {
        return 'Không lấy được giá vàng live. Hãy thử lại sau.';
      }
      if (body.code === 'rate_limit_exceeded') {
        return 'Đã chạm giới hạn yêu cầu của Gold Analyst. Hãy thử lại sau.';
      }
      if (body.code === 'analysis_validation_failed') {
        return 'AI đã trả về nội dung không đạt kiểm tra trích dẫn/dữ liệu nên hệ thống không hiển thị. Hãy thử model khác trong Settings.';
      }
      return body.error || `API error ${response.status}`;
    } catch {
      return `API error ${response.status}`;
    }
  }

  async send(query: string): Promise<void> {
    if (this.isStreaming) return;
    const trimmedQuery = query.trim().slice(0, 600);
    if (!trimmedQuery) return;

    this.isStreaming = true;
    this.setControlsDisabled(true);
    this.appendUserMessage(trimmedQuery);

    const { bubble, body } = this.appendStreamingBubble();
    const controller = new AbortController();
    this.streamAbort = controller;
    let accumulated = '';
    let meta: GoldAnalystMeta | null = null;
    const settings = getGoldAnalystSettings();

    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: trimmedQuery,
          history: this.history.slice(-MAX_HISTORY_MESSAGES),
          provider: settings.provider,
          model: settings.model,
          mode: settings.mode,
          allowFallback: settings.allowFallback,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        this.finalize(body, `⚠ ${await this.describeError(response)}`, false);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        this.finalize(body, '⚠ Không mở được luồng phản hồi.', false);
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let receivedDone = false;

      while (true) {
        const result = await reader.read();
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const payload = JSON.parse(line.slice(6)) as {
              delta?: string;
              done?: boolean;
              error?: string;
              meta?: GoldAnalystMeta;
            };
            if (payload.meta) {
              meta = payload.meta;
              this.renderMeta(bubble, payload.meta);
            }
            if (payload.error) {
              this.finalize(body, '⚠ AI provider hiện không phản hồi. Hãy thử lại hoặc đổi model trong Settings.', false);
              return;
            }
            if (payload.delta) {
              accumulated += payload.delta;
              body.appendChild(document.createTextNode(payload.delta));
              this.scrollToBottom();
            }
            if (payload.done) {
              receivedDone = true;
              break;
            }
          } catch {
            // Ignore a malformed SSE line and continue reading the stream.
          }
        }
        if (receivedDone) break;
      }

      if (!receivedDone || !accumulated.trim()) {
        this.finalize(
          body,
          accumulated
            ? `${accumulated}\n\n⚠ *Phản hồi có thể chưa hoàn tất.*`
            : '⚠ Phản hồi bị gián đoạn. Hãy thử lại.',
          false,
        );
        return;
      }

      this.finalize(body, accumulated, true);
      if (meta) {
        this.renderObservations(bubble, meta);
        this.renderCitations(bubble, meta, accumulated);
      }
      this.history.push(
        { role: 'user', content: trimmedQuery },
        { role: 'assistant', content: accumulated },
      );
      if (this.history.length > MAX_HISTORY_MESSAGES) {
        this.history = this.history.slice(-MAX_HISTORY_MESSAGES);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.finalize(body, accumulated || '⚠ Yêu cầu đã được hủy.', false);
      } else {
        this.finalize(body, '⚠ Lỗi kết nối tới Gold Analyst.', false);
      }
    } finally {
      if (this.streamAbort === controller) {
        this.streamAbort = null;
        this.isStreaming = false;
        this.setControlsDisabled(false);
      }
      bubble.classList.remove('chat-msg-streaming');
    }
  }

  private finalize(element: HTMLElement, content: string, success: boolean): void {
    if (!success) element.classList.add('chat-msg-error');
    void yieldToMain().then(() => {
      if (!element.isConnected) return;
      setTrustedHtml(element, renderMarkdown(content));
      this.scrollToBottom();
    });
  }

  private scrollToBottom(): void {
    requestAnimationFrame(() => {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    });
  }

  private clear(): void {
    this.history = [];
    this.streamAbort?.abort();
    this.streamAbort = null;
    this.isStreaming = false;
    this.setControlsDisabled(false);
    this.showWelcome();
  }

  override destroy(): void {
    this.streamAbort?.abort();
    this.streamAbort = null;
    window.removeEventListener(GOLD_ANALYST_SETTINGS_CHANGED, this.settingsChanged);
    super.destroy();
  }
}
