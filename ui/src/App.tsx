import { useState, useEffect, useMemo } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import {
  Clock,
  Zap,
  Hash,
  ArrowRight,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import {
  parseSSEToEvents,
  summarizeAnthropicSSE,
  getMessageText,
  isRecord,
  calculateTokens,
  getResponseBody,
  extractTextFromContent,
  prettifyText,
} from "@/lib/utils";

// Constants
const MAX_TRACES = 100;
const WS_URL = "ws://localhost:3002";
const API_BASE_URL = "http://localhost:3000";

// Types
interface TokenUsage {
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}

interface Message {
  role: string;
  content: unknown;
}

interface Tool {
  name: string;
  description?: string;
  input_schema?: unknown;
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  [key: string]: unknown;
}

interface ResponseBody {
  content?: ContentBlock[];
  stop_reason?: string;
  usage?: TokenUsage;
  [key: string]: unknown;
}

interface TraceResponse {
  body?: ResponseBody | string;
  status?: number;
  latency?: number;
  [key: string]: unknown;
}

interface Trace {
  id: string;
  timestamp: string;
  model?: string;
  messages?: Message[];
  tools?: Tool[];
  temperature?: number;
  max_tokens?: number;
  response?: TraceResponse | ResponseBody | string;
  latency?: number;
  tokensUsed?: TokenUsage;
}

export default function App() {
  const [connected, setConnected] = useState(false);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [selectedTrace, setSelectedTrace] = useState<Trace | null>(null);
  const [clearOpen, setClearOpen] = useState(false);

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = (error) => console.error("WebSocket error:", error);
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "request") {
          setTraces((prev) => [message.data, ...prev.slice(0, MAX_TRACES - 1)]);
        } else if (message.type === "response") {
          setTraces((prev) =>
            prev.map((t) =>
              t.id === message.data.requestId ? { ...t, ...message.data } : t
            )
          );
        } else if (message.type === "cleared") {
          setTraces([]);
          setSelectedTrace(null);
        }
      } catch (error) {
        console.error("Failed to parse WebSocket message:", error);
      }
    };

    // Load persisted recent traces
    (async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/api/traces`);
        const serverTraces: unknown = await res.json();
        const mapped = (Array.isArray(serverTraces) ? serverTraces : []).map(
          (st: unknown): Trace => {
            if (!isRecord(st)) {
              return {
                id: String(st),
                timestamp: new Date().toISOString(),
              };
            }

            const body = st.body;
            const responseWrapped = st.response;
            const responseBody = isRecord(responseWrapped)
              ? responseWrapped.body ?? responseWrapped
              : null;
            const tokensUsed = isRecord(responseBody)
              ? responseBody.usage ?? null
              : null;

            return {
              id: String(st.id ?? ''),
              timestamp: String(st.timestamp ?? new Date().toISOString()),
              model: isRecord(body) && typeof body.model === 'string' ? body.model : undefined,
              messages: isRecord(body) && Array.isArray(body.messages) ? body.messages as Message[] : undefined,
              tools: isRecord(body) && Array.isArray(body.tools) ? body.tools as Tool[] : undefined,
              temperature: isRecord(body) && typeof body.temperature === 'number' ? body.temperature : undefined,
              max_tokens: isRecord(body) && typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
              response: responseBody as ResponseBody | string | undefined,
              latency: isRecord(responseWrapped) && typeof responseWrapped.latency === 'number' ? responseWrapped.latency : undefined,
              tokensUsed: isRecord(tokensUsed) ? tokensUsed as TokenUsage : undefined,
            };
          }
        );
        setTraces(mapped);
      } catch {
        // ignore
      }
    })();

    return () => {
      ws.close();
    };
  }, []);

  const visibleRequestCount = useMemo(() => traces.length, [traces]);
  const visibleTokenCount = useMemo(() => {
    return traces.reduce((acc, t) => acc + calculateTokens(t.tokensUsed), 0);
  }, [traces]);
  const avgLatencyMs = useMemo(() => {
    const latencies = traces
      .map((t) => t.latency)
      .filter((v): v is number => typeof v === "number" && isFinite(v));
    if (latencies.length === 0) return 0;
    const sum = latencies.reduce((a, b) => a + b, 0);
    return sum / latencies.length;
  }, [traces]);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border bg-card px-4 py-3">
        <h1 className="text-lg font-semibold">Claude Code Tracer</h1>
        <Separator orientation="vertical" className="h-6" />
        <div className="ml-auto flex items-center gap-4 text-sm">
          <Badge variant={connected ? "default" : "destructive"}>
            {connected ? "Connected" : "Disconnected"}
          </Badge>
          <span className="text-muted-foreground">
            <Hash className="inline h-4 w-4" /> {visibleRequestCount} requests
          </span>
          <span className="text-muted-foreground">
            <Zap className="inline h-4 w-4" /> {visibleTokenCount} tokens
          </span>
          <span className="text-muted-foreground">
            <Clock className="inline h-4 w-4" /> {Math.round(avgLatencyMs)}ms
            avg
          </span>
          <Dialog open={clearOpen} onOpenChange={setClearOpen}>
            <DialogTrigger asChild>
              <button
                type="button"
                className="ml-2 inline-flex items-center rounded border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-muted"
                aria-label="Clear traces"
              >
                Clear traces
              </button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Clear all traces?</DialogTitle>
                <DialogDescription>
                  This will delete all traces from your local database. This
                  action cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <button
                    type="button"
                    className="inline-flex items-center rounded border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
                  >
                    Cancel
                  </button>
                </DialogClose>
                <button
                  type="button"
                  className="inline-flex items-center rounded bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:bg-destructive/90"
                  onClick={async () => {
                    try {
                      await fetch(`${API_BASE_URL}/api/clear`, {
                        method: "POST",
                      });
                    } catch (error) {
                      console.error("Failed to clear traces:", error);
                    }
                    setTraces([]);
                    setSelectedTrace(null);
                    setClearOpen(false);
                  }}
                >
                  Clear traces
                </button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Trace List */}
        <div className="w-96 overflow-y-auto border-r border-border bg-background p-4">
          {traces.length === 0 ? (
            <p className="text-center text-muted-foreground">
              Waiting for traces...
            </p>
          ) : (
            <div className="space-y-2">
              {traces.map((t) => (
                <Card
                  key={t.id}
                  className={`cursor-pointer transition-all ${
                    selectedTrace?.id === t.id
                      ? "border-primary bg-accent"
                      : "hover:border-muted-foreground/50"
                  }`}
                  onClick={() => setSelectedTrace(t)}
                >
                  <CardHeader className="p-3 pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="text-sm font-medium">
                        {t.model || "Unknown"}
                      </CardTitle>
                      {t.response && (
                        <Badge variant="secondary" className="text-xs">
                          <CheckCircle2 className="mr-1 h-3 w-3" />
                          {t.latency}ms
                        </Badge>
                      )}
                    </div>
                    <CardDescription className="text-xs">
                      {new Date(t.timestamp).toLocaleTimeString()}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="p-3 pt-0">
                    <p className="line-clamp-2 text-xs text-muted-foreground">
                      {getMessageText(t.messages)}
                    </p>
                    <TokenDisplay tokensUsed={t.tokensUsed} />
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>

        {/* Detail Panel */}
        <div className="flex-1 overflow-y-auto bg-background p-6">
          {selectedTrace ? (
            <TraceDetail trace={selectedTrace} />
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              Select a trace to view details
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TraceDetail({ trace }: { trace: Trace }) {
  return (
    <Tabs defaultValue="overview" className="w-full">
      <TabsList className="grid w-full grid-cols-4">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="request">Request</TabsTrigger>
        <TabsTrigger value="response">Response</TabsTrigger>
        <TabsTrigger value="raw">Raw</TabsTrigger>
      </TabsList>

      <TabsContent value="overview" className="space-y-4">
        <PrettyTab trace={trace} />
      </TabsContent>

      <TabsContent value="request" className="space-y-4">
        <RequestTab trace={trace} />
      </TabsContent>

      <TabsContent value="response" className="space-y-4">
        <ResponseTab trace={trace} />
      </TabsContent>

      <TabsContent value="raw" className="space-y-4">
        <RawTab trace={trace} />
      </TabsContent>
    </Tabs>
  );
}

function PrettyTab({ trace }: { trace: Trace }) {
  return (
    <div className="space-y-6">
      {/* Metadata Card */}
      <Card>
        <CardHeader>
          <CardTitle>Request Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-muted-foreground">Model</p>
              <Badge variant="outline" className="mt-1">
                {trace.model || "N/A"}
              </Badge>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Timestamp</p>
              <p className="mt-1 text-sm font-medium text-foreground">
                {new Date(trace.timestamp).toLocaleString()}
              </p>
            </div>
            {trace.latency && (
              <div>
                <p className="text-sm text-muted-foreground">Latency</p>
                <div className="mt-1 flex items-center gap-2">
                  <Clock className="h-4 w-4 text-chart-3" />
                  <span className="text-sm font-medium text-foreground">
                    {trace.latency}ms
                  </span>
                </div>
              </div>
            )}
            {trace.tokensUsed && (
              <div>
                <p className="text-sm text-muted-foreground">Total Tokens</p>
                <div className="mt-1 flex items-center gap-2">
                  <Zap className="h-4 w-4 text-chart-3" />
                  <span className="text-sm font-medium text-foreground">
                    {trace.tokensUsed.total_tokens || 0}
                  </span>
                </div>
              </div>
            )}
          </div>

          {trace.tokensUsed && (
            <>
              <Separator />
              <div>
                <p className="mb-2 text-sm font-medium text-muted-foreground">
                  Token Breakdown
                </p>
                <div className="flex gap-4">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">Input</Badge>
                    <span className="text-sm text-foreground">
                      {trace.tokensUsed.input_tokens || 0}
                    </span>
                  </div>
                  <ArrowRight className="h-4 w-4 self-center text-muted-foreground" />
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">Output</Badge>
                    <span className="text-sm text-foreground">
                      {trace.tokensUsed.output_tokens || 0}
                    </span>
                  </div>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Messages */}
      <Card>
        <CardHeader>
          <CardTitle>Conversation</CardTitle>
          <CardDescription>Messages sent in this request</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {trace.messages?.map((msg, i) => (
            <div key={i} className="space-y-2">
              <Badge variant={msg.role === "user" ? "default" : "secondary"}>
                {msg.role}
              </Badge>
              <CodeBlock>{extractTextFromContent(msg.content)}</CodeBlock>
            </div>
          ))}
        </CardContent>
      </Card>

      <ResponseCard trace={trace} />
    </div>
  );
}

function ResponseCard({ trace }: { trace: Trace }) {
  const responseBody = getResponseBody(trace);
  const contentBlocks =
    isRecord(responseBody) && Array.isArray(responseBody.content)
      ? responseBody.content as ContentBlock[]
      : null;

  if (!contentBlocks) return null;

  let summaryText = "";
  if (typeof responseBody === "string") {
    const s = summarizeAnthropicSSE(responseBody);
    summaryText = s.text;
  } else if (isRecord(responseBody) && Array.isArray(responseBody.content)) {
    const textBlocks = responseBody.content.filter(
      (c): c is ContentBlock => isRecord(c) && c.type === "text"
    );
    summaryText = textBlocks.map((b) => b.text || "").join("\n\n");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Response</CardTitle>
        {isRecord(responseBody) && responseBody.stop_reason ? (
          <CardDescription>
            <Badge variant="outline" className="mt-1">
              {String(responseBody.stop_reason)}
            </Badge>
          </CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {summaryText && (
          <div className="space-y-2">
            <Badge variant="secondary">Summary</Badge>
            <CodeBlock>{summaryText}</CodeBlock>
            <Separator />
          </div>
        )}
        {contentBlocks.map((block, i) => (
          <div key={i} className="space-y-2">
            <Badge variant={block.type === "text" ? "default" : "secondary"}>
              {block.type}
            </Badge>
            {block.type === "text" ? (
              <CodeBlock>{block.text || ""}</CodeBlock>
            ) : (
              <div className="rounded-lg bg-muted p-4">
                <pre className="whitespace-pre-wrap text-sm text-foreground">
                  {JSON.stringify(block, null, 2)}
                </pre>
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function RequestTab({ trace }: { trace: Trace }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Request Parameters</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Field label="Model" value={trace.model} />
          <Field label="Max Tokens" value={trace.max_tokens} />
          <Field label="Temperature" value={trace.temperature ?? "N/A"} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Messages</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="overflow-auto rounded-lg bg-muted p-4 text-xs text-foreground">
            {JSON.stringify(trace.messages, null, 2)}
          </pre>
        </CardContent>
      </Card>

      {trace.tools && trace.tools.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Tools</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="overflow-auto rounded-lg bg-muted p-4 text-xs text-foreground">
              {JSON.stringify(trace.tools, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ResponseTab({ trace }: { trace: Trace }) {
  const responseBody = getResponseBody(trace);
  if (!responseBody) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center p-12 text-muted-foreground">
          <XCircle className="mr-2 h-5 w-5" />
          No response yet...
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Response Metadata</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Field
            label="Status"
            value={isRecord(trace.response) ? trace.response.status ?? "N/A" : "N/A"}
          />
          <Field label="Latency" value={`${trace.latency ?? "N/A"}ms`} />
          <Field
            label="Stop Reason"
            value={isRecord(responseBody) ? responseBody.stop_reason ?? "N/A" : "N/A"}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Content</CardTitle>
        </CardHeader>
        <CardContent>
          {typeof responseBody === "string" ? (
            // Pretty SSE viewer
            <div className="space-y-4">
              {(() => {
                const summary = summarizeAnthropicSSE(responseBody);
                return (
                  <div className="space-y-2">
                    <Badge variant="secondary">Summary</Badge>
                    <CodeBlock>{summary.text || "(no text body)"}</CodeBlock>
                    <div className="text-sm text-muted-foreground">
                      Stop reason: {summary.stopReason ?? "N/A"}
                    </div>
                  </div>
                );
              })()}
              <Separator />
              <div className="space-y-2">
                <Badge>Events</Badge>
                <div className="rounded-lg bg-muted p-4">
                  <pre className="overflow-auto whitespace-pre rounded bg-muted p-0 text-xs text-foreground">
                    {JSON.stringify(parseSSEToEvents(responseBody), null, 2)}
                  </pre>
                </div>
              </div>
            </div>
          ) : (
            <pre className="overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-4 text-xs text-foreground">
              {JSON.stringify(responseBody, null, 2)}
            </pre>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function RawTab({ trace }: { trace: Trace }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Complete Trace Data</CardTitle>
        <CardDescription>Full JSON representation of the trace</CardDescription>
      </CardHeader>
      <CardContent>
        <pre className="overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-4 text-xs text-foreground">
          {JSON.stringify(trace, null, 2)}
        </pre>
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: unknown;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-sm text-muted-foreground">{label}:</span>
      <span
        className={`text-sm font-medium text-foreground ${
          mono ? "font-mono" : ""
        }`}
      >
        {String(value)}
      </span>
    </div>
  );
}

function TokenDisplay({ tokensUsed }: { tokensUsed?: TokenUsage }) {
  const totalTokens = calculateTokens(tokensUsed);
  if (totalTokens === 0) return null;

  return <p className="mt-1 text-xs text-chart-2">{totalTokens} tokens</p>;
}

function CodeBlock({ children }: { children: string }) {
  return (
    <div className="rounded-lg bg-muted p-4">
      <pre className="whitespace-pre-wrap text-sm text-foreground">
        {prettifyText(children)}
      </pre>
    </div>
  );
}
