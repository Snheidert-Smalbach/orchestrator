import { Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { deleteAllProjectMocks, deleteProjectMock, getProjectMocks, saveProjectMock } from "../lib/tauri";
import type { MockHeader, MockKind, Project, ProjectMock, ProjectMockCollection } from "../lib/types";
import { useTranslation } from "../i18n";
import { useAppStore } from "../store/useAppStore";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { EmptyState } from "./ui/empty-state";
import { FieldGroup, FieldLabel, FieldLabelWrap } from "./ui/field";
import { Input } from "./ui/input";
import { Select } from "./ui/select";
import { Textarea } from "./ui/textarea";

type MockEditorState = {
  mock: ProjectMock;
  requestHeadersText: string;
  responseHeadersText: string;
  graphqlQuery: string;
  graphqlVariablesText: string;
  graphqlOperationName: string;
};

const DEFAULT_GRAPHQL_RESPONSE = JSON.stringify({ data: {} }, null, 2);
const DEFAULT_REST_RESPONSE = JSON.stringify({ ok: true }, null, 2);

function emptySummary(): ProjectMockCollection["summary"] {
  return {
    totalCount: 0,
    graphqlCount: 0,
    restCount: 0,
    manualCount: 0,
    capturedCount: 0,
    lastUpdatedAt: null,
    routes: [],
  };
}

function createMockId() {
  return `mock-${Math.random().toString(36).slice(2, 10)}`;
}

function createEmptyMock(kind: Extract<MockKind, "rest" | "graphql">, name: string): ProjectMock {
  const isGraphql = kind === "graphql";
  return {
    id: createMockId(),
    name,
    source: "manual",
    kind,
    recordedAt: new Date().toISOString(),
    notes: null,
    requestMethod: isGraphql ? "POST" : "GET",
    requestPath: isGraphql ? "/graphql" : "/api/resource",
    requestQuery: "",
    requestHeaders: [],
    requestContentType: "application/json",
    requestBody: isGraphql
      ? JSON.stringify({ query: "query Ping {\n  ping\n}", variables: {} }, null, 2)
      : "",
    responseStatusCode: 200,
    responseReasonPhrase: "OK",
    responseHeaders: [],
    responseContentType: "application/json",
    responseBody: isGraphql ? DEFAULT_GRAPHQL_RESPONSE : DEFAULT_REST_RESPONSE,
  };
}

function headersToText(headers: MockHeader[]) {
  return headers.map((header) => `${header.name}: ${header.value}`).join("\n");
}

function splitHeaderLine(line: string) {
  const separatorIndex = line.includes(":") ? line.indexOf(":") : line.indexOf("=");
  if (separatorIndex < 0) {
    return null;
  }

  return {
    name: line.slice(0, separatorIndex).trim(),
    value: line.slice(separatorIndex + 1).trim(),
  };
}

function textToHeaders(text: string, invalidHeaderMessage: (line: string) => string): MockHeader[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parsed = splitHeaderLine(line);
      if (!parsed?.name) {
        throw new Error(invalidHeaderMessage(line));
      }

      return parsed satisfies MockHeader;
    });
}

function parseGraphqlBody(body: string) {
  try {
    const parsed = JSON.parse(body) as {
      query?: unknown;
      variables?: unknown;
      operationName?: unknown;
    };

    return {
      query: typeof parsed.query === "string" ? parsed.query : "",
      variablesText: JSON.stringify(parsed.variables ?? {}, null, 2),
      operationName: typeof parsed.operationName === "string" ? parsed.operationName : "",
    };
  } catch {
    return {
      query: body,
      variablesText: "{}",
      operationName: "",
    };
  }
}

function createEditorState(mock: ProjectMock): MockEditorState {
  const graphqlState = mock.kind === "graphql" ? parseGraphqlBody(mock.requestBody) : null;

  return {
    mock: {
      ...mock,
      requestHeaders: mock.requestHeaders ?? [],
      responseHeaders: mock.responseHeaders ?? [],
      requestContentType: mock.requestContentType ?? "application/json",
      responseContentType: mock.responseContentType ?? "application/json",
      notes: mock.notes ?? null,
    },
    requestHeadersText: headersToText(mock.requestHeaders ?? []),
    responseHeadersText: headersToText(mock.responseHeaders ?? []),
    graphqlQuery: graphqlState?.query ?? "",
    graphqlVariablesText: graphqlState?.variablesText ?? "{}",
    graphqlOperationName: graphqlState?.operationName ?? "",
  };
}

function formatTimestamp(value: string | null, noDateLabel: string, locale: string) {
  if (!value) {
    return noDateLabel;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString(locale, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildMockFromEditor(
  editor: MockEditorState,
  invalidHeaderMessage: (line: string) => string,
  graphqlMissingQueryMessage: string,
): ProjectMock {
  const requestHeaders = textToHeaders(editor.requestHeadersText, invalidHeaderMessage);
  const responseHeaders = textToHeaders(editor.responseHeadersText, invalidHeaderMessage);
  const mock = {
    ...editor.mock,
    requestHeaders,
    responseHeaders,
    requestMethod: editor.mock.requestMethod.toUpperCase(),
    requestPath: editor.mock.requestPath.trim() || "/",
    requestQuery: editor.mock.requestQuery.trim(),
    responseStatusCode: Number(editor.mock.responseStatusCode || 200),
    responseReasonPhrase: editor.mock.responseReasonPhrase.trim() || "OK",
    notes: editor.mock.notes?.trim() ? editor.mock.notes.trim() : null,
  } satisfies ProjectMock;

  if (mock.kind === "graphql") {
    if (!editor.graphqlQuery.trim()) {
      throw new Error(graphqlMissingQueryMessage);
    }

    let variables: unknown = {};
    if (editor.graphqlVariablesText.trim()) {
      variables = JSON.parse(editor.graphqlVariablesText);
    }

    const bodyPayload: Record<string, unknown> = {
      query: editor.graphqlQuery,
      variables,
    };
    if (editor.graphqlOperationName.trim()) {
      bodyPayload.operationName = editor.graphqlOperationName.trim();
    }

    return {
      ...mock,
      requestMethod: "POST",
      requestContentType: mock.requestContentType || "application/json",
      responseContentType: mock.responseContentType || "application/json",
      requestBody: JSON.stringify(bodyPayload, null, 2),
    };
  }

  return mock;
}

export function ProjectMocksEditor({ project }: { project: Project }) {
  const { t, language } = useTranslation();
  const patchProjectMockSummary = useAppStore((state) => state.patchProjectMockSummary);
  const [collection, setCollection] = useState<ProjectMockCollection>({
    summary: project.mockSummary,
    mocks: [],
  });
  const [editor, setEditor] = useState<MockEditorState | null>(null);
  const [selectedMockId, setSelectedMockId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isClearingAll, setIsClearingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editorViewportRef = useRef<HTMLDivElement | null>(null);
  const listItemRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const dateLocale = language === "es" ? "es-CO" : "en-US";
  const noDateLabel = t("mocks.noDate");

  function getInvalidHeaderMessage(line: string) {
    return t("mocks.invalidHeader", { line });
  }

  async function refreshMocks(preferredMockId?: string | null) {
    setIsLoading(true);
    setError(null);

    try {
      const nextCollection = await getProjectMocks(project.id);
      setCollection(nextCollection);
      patchProjectMockSummary(project.id, nextCollection.summary);

      const nextSelectedMock = nextCollection.mocks.find((mock) => mock.id === preferredMockId) ?? nextCollection.mocks[0] ?? null;
      setSelectedMockId(nextSelectedMock?.id ?? null);
      setEditor(nextSelectedMock ? createEditorState(nextSelectedMock) : null);
    } catch (loadError) {
      setCollection({ summary: emptySummary(), mocks: [] });
      setEditor(null);
      setSelectedMockId(null);
      setError(loadError instanceof Error ? loadError.message : t("mocks.errorLoad"));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    setCollection((current) => ({
      ...current,
      summary: project.mockSummary,
    }));
  }, [project.id, project.mockSummary]);

  useEffect(() => {
    void refreshMocks();
  }, [patchProjectMockSummary, project.id]);

  useEffect(() => {
    if (selectedMockId) {
      listItemRefs.current[selectedMockId]?.scrollIntoView({
        block: "nearest",
      });
    }
    editorViewportRef.current?.scrollTo({ top: 0 });
  }, [selectedMockId, editor?.mock.id]);

  function selectMock(mock: ProjectMock) {
    setSelectedMockId(mock.id);
    setEditor(createEditorState(mock));
    setError(null);
  }

  function handleCreate(kind: Extract<MockKind, "rest" | "graphql">) {
    const defaultName = kind === "graphql" ? "New GraphQL mock" : "New REST mock";
    setSelectedMockId(null);
    setEditor(createEditorState(createEmptyMock(kind, defaultName)));
    setError(null);
  }

  async function handleSave() {
    if (!editor) {
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const savedMock = buildMockFromEditor(
        editor,
        getInvalidHeaderMessage,
        t("mocks.graphqlMissingQuery"),
      );
      const nextCollection = await saveProjectMock(project.id, savedMock);
      setCollection(nextCollection);
      patchProjectMockSummary(project.id, nextCollection.summary);

      const persistedMock = nextCollection.mocks.find((mock) => mock.id === savedMock.id) ?? nextCollection.mocks[0] ?? null;
      setSelectedMockId(persistedMock?.id ?? null);
      setEditor(persistedMock ? createEditorState(persistedMock) : null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t("mocks.errorSave"));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete() {
    if (!editor) {
      return;
    }

    if (!selectedMockId) {
      setEditor(null);
      setError(null);
      return;
    }

    setIsDeleting(true);
    setError(null);

    try {
      const nextCollection = await deleteProjectMock(project.id, selectedMockId);
      setCollection(nextCollection);
      patchProjectMockSummary(project.id, nextCollection.summary);
      const nextSelectedMock = nextCollection.mocks[0] ?? null;
      setSelectedMockId(nextSelectedMock?.id ?? null);
      setEditor(nextSelectedMock ? createEditorState(nextSelectedMock) : null);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : t("mocks.errorDelete"));
    } finally {
      setIsDeleting(false);
    }
  }

  async function handleDeleteAll() {
    if (!collection.mocks.length) {
      return;
    }

    setIsClearingAll(true);
    setError(null);

    try {
      const nextCollection = await deleteAllProjectMocks(project.id);
      setCollection(nextCollection);
      patchProjectMockSummary(project.id, nextCollection.summary);
      setSelectedMockId(null);
      setEditor(null);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : t("mocks.errorDeleteAll"));
    } finally {
      setIsClearingAll(false);
    }
  }

  const selectedDescriptor = editor
    ? `${editor.mock.requestMethod} ${editor.mock.requestPath}${editor.mock.requestQuery ? `?${editor.mock.requestQuery}` : ""}`
    : null;

  const summary = t(
    collection.summary.totalCount === 1 ? "mocks.summary" : "mocks.summaryPlural",
    {
      total: String(collection.summary.totalCount),
      manual: String(collection.summary.manualCount),
      captured: String(collection.summary.capturedCount),
    },
  );

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="surface-panel-soft flex shrink-0 flex-wrap items-center justify-between gap-2 px-3 py-2">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-[0.16em] text-textSoft">{t("mocks.section")}</p>
          <p className="mt-0.5 truncate text-[11px] text-textMuted">{summary}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button type="button" variant="secondary" size="sm" onClick={() => void refreshMocks(selectedMockId)} disabled={isLoading}>
            <RefreshCw className={["h-3 w-3", isLoading ? "animate-spin" : ""].join(" ")} />
            {t("mocks.refreshBtn")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => void handleDeleteAll()}
            disabled={isClearingAll || !collection.summary.totalCount}
          >
            <Trash2 className="h-3 w-3" />
            {isClearingAll ? t("mocks.deletingAll") : t("mocks.deleteAllBtn")}
          </Button>
          <Button type="button" variant="default" size="sm" onClick={() => handleCreate("rest")}>
            <Plus className="h-3 w-3" />
            {t("mocks.newRestBtn")}
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => handleCreate("graphql")} className="text-info">
            <Plus className="h-3 w-3" />
            {t("mocks.newGraphqlBtn")}
          </Button>
        </div>
      </div>

      <div className="mt-2 grid min-h-0 flex-1 gap-2 xl:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="surface-panel-soft flex min-h-0 flex-col overflow-hidden">
          <div className="surface-divider flex shrink-0 flex-wrap items-center justify-between gap-1.5 px-2.5 py-2">
            <div className="flex min-w-0 flex-wrap gap-1">
              <Badge variant="secondary">{collection.summary.graphqlCount} gql</Badge>
              <Badge variant="secondary">{collection.summary.restCount} rest</Badge>
            </div>
            <span className="text-[9px] uppercase tracking-[0.14em] text-textSoft">
              {formatTimestamp(collection.summary.lastUpdatedAt, noDateLabel, dateLocale)}
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-auto px-2 py-2 scrollbar-thin">
            <div className="grid gap-1">
              {collection.mocks.length ? (
                collection.mocks.map((mock) => (
                  <button
                    key={mock.id}
                    ref={(node) => {
                      listItemRefs.current[mock.id] = node;
                    }}
                    type="button"
                    className={[
                      "ui-mock-list-item",
                      selectedMockId === mock.id ? "ui-mock-list-item--active" : "",
                    ].join(" ")}
                    onClick={() => selectMock(mock)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[10px] font-semibold uppercase tracking-[0.08em] text-textStrong">
                        {mock.requestMethod}
                      </span>
                      <div className="flex shrink-0 items-center gap-1">
                        <Badge variant="secondary" className="px-1 py-0.5 text-[8px]">
                          {mock.kind}
                        </Badge>
                        {mock.source === "manual" ? (
                          <Badge variant="info" className="px-1 py-0.5 text-[8px]">
                            manual
                          </Badge>
                        ) : null}
                      </div>
                    </div>
                    <p className="mt-1 truncate text-[11px] text-textStrong">
                      {mock.requestPath}
                      {mock.requestQuery ? `?${mock.requestQuery}` : ""}
                    </p>
                    <p className="mt-1 truncate text-[10px] text-textSoft">
                      {mock.name} | {mock.responseStatusCode}
                    </p>
                  </button>
                ))
              ) : (
                <EmptyState
                  title={t("mocks.emptyTitle")}
                  description={t("mocks.emptyDesc")}
                />
              )}
            </div>
          </div>
        </aside>

        <section className="surface-panel-soft flex min-h-0 flex-col overflow-hidden">
          {editor ? (
            <>
              <div className="surface-divider flex shrink-0 flex-wrap items-start justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-[11px] font-semibold text-textStrong">{editor.mock.name}</p>
                  <p className="mt-0.5 truncate text-[10px] text-textMuted">{selectedDescriptor}</p>
                  <p className="mt-0.5 text-[10px] text-textSoft">
                    {selectedMockId
                      ? editor.mock.source === "manual"
                        ? t("mocks.sourceManual")
                        : t("mocks.sourceCaptured")
                      : t("mocks.sourceNew")}{" "}
                    | {formatTimestamp(editor.mock.recordedAt, noDateLabel, dateLocale)}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-1.5">
                  <Button type="button" variant="destructive" size="sm" onClick={() => void handleDelete()} disabled={isDeleting}>
                    <Trash2 className="h-3 w-3" />
                    {selectedMockId ? t("mocks.deleteBtn") : t("mocks.discardBtn")}
                  </Button>
                  <Button type="button" variant="default" size="sm" onClick={() => void handleSave()} disabled={isSaving}>
                    <Save className="h-3 w-3" />
                    {isSaving ? t("mocks.savingBtn") : t("mocks.saveBtn")}
                  </Button>
                </div>
              </div>

              <div ref={editorViewportRef} className="min-h-0 flex-1 overflow-auto px-3 py-2.5 scrollbar-thin">
                <div className="grid gap-2.5">
                  <div className="grid gap-2 xl:grid-cols-[minmax(0,1fr)_120px_120px]">
                    <FieldLabelWrap>
                      <FieldLabel>{t("mocks.nameLabel")}</FieldLabel>
                      <Input
                        value={editor.mock.name}
                        onChange={(event) => setEditor({ ...editor, mock: { ...editor.mock, name: event.target.value } })}
                      />
                    </FieldLabelWrap>
                    <FieldLabelWrap>
                      <FieldLabel>{t("mocks.typeLabel")}</FieldLabel>
                      <Select
                        value={editor.mock.kind}
                        onChange={(event) => {
                          const nextKind = event.target.value as ProjectMock["kind"];
                          setEditor((current) => {
                            if (!current) {
                              return current;
                            }

                            const nextEditor = {
                              ...current,
                              mock: {
                                ...current.mock,
                                kind: nextKind,
                                requestMethod: nextKind === "graphql" ? "POST" : current.mock.requestMethod,
                                requestPath:
                                  nextKind === "graphql" && current.mock.requestPath === "/api/resource"
                                    ? "/graphql"
                                    : current.mock.requestPath,
                                requestContentType: "application/json",
                                responseContentType: "application/json",
                              },
                            };

                            if (nextKind === "graphql" && !current.graphqlQuery.trim()) {
                              return {
                                ...nextEditor,
                                graphqlQuery: "query Ping {\n  ping\n}",
                                graphqlVariablesText: "{}",
                              };
                            }

                            return nextEditor;
                          });
                        }}
                      >
                        <option value="rest">rest</option>
                        <option value="graphql">graphql</option>
                        <option value="http_other">http_other</option>
                      </Select>
                    </FieldLabelWrap>
                    <FieldLabelWrap>
                      <FieldLabel>{t("mocks.statusLabel")}</FieldLabel>
                      <Input
                        type="number"
                        value={editor.mock.responseStatusCode}
                        onChange={(event) =>
                          setEditor({
                            ...editor,
                            mock: {
                              ...editor.mock,
                              responseStatusCode: Number(event.target.value || 200),
                            },
                          })
                        }
                      />
                    </FieldLabelWrap>
                  </div>

                  <div className="grid gap-2 xl:grid-cols-[90px_minmax(0,1fr)_minmax(0,0.8fr)]">
                    <FieldLabelWrap>
                      <FieldLabel>{t("mocks.methodLabel")}</FieldLabel>
                      <Input
                        value={editor.mock.requestMethod}
                        onChange={(event) =>
                          setEditor({
                            ...editor,
                            mock: { ...editor.mock, requestMethod: event.target.value.toUpperCase() },
                          })
                        }
                        disabled={editor.mock.kind === "graphql"}
                      />
                    </FieldLabelWrap>
                    <FieldLabelWrap>
                      <FieldLabel>{t("mocks.pathLabel")}</FieldLabel>
                      <Input
                        value={editor.mock.requestPath}
                        onChange={(event) =>
                          setEditor({
                            ...editor,
                            mock: { ...editor.mock, requestPath: event.target.value },
                          })
                        }
                      />
                    </FieldLabelWrap>
                    <FieldLabelWrap>
                      <FieldLabel>{t("mocks.queryLabel")}</FieldLabel>
                      <Input
                        value={editor.mock.requestQuery}
                        onChange={(event) =>
                          setEditor({
                            ...editor,
                            mock: { ...editor.mock, requestQuery: event.target.value },
                          })
                        }
                      />
                    </FieldLabelWrap>
                  </div>

                  {editor.mock.kind === "graphql" ? (
                    <div className="grid gap-2 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
                      <FieldLabelWrap>
                        <FieldLabel>{t("mocks.graphqlQueryLabel")}</FieldLabel>
                        <Textarea rows={8} value={editor.graphqlQuery} onChange={(event) => setEditor({ ...editor, graphqlQuery: event.target.value })} />
                      </FieldLabelWrap>
                      <div className="grid gap-2">
                        <FieldLabelWrap>
                          <FieldLabel>{t("mocks.variablesLabel")}</FieldLabel>
                          <Textarea
                            rows={6}
                            value={editor.graphqlVariablesText}
                            onChange={(event) => setEditor({ ...editor, graphqlVariablesText: event.target.value })}
                          />
                        </FieldLabelWrap>
                        <FieldLabelWrap>
                          <FieldLabel>{t("mocks.operationLabel")}</FieldLabel>
                          <Input
                            value={editor.graphqlOperationName}
                            onChange={(event) => setEditor({ ...editor, graphqlOperationName: event.target.value })}
                          />
                        </FieldLabelWrap>
                      </div>
                    </div>
                  ) : (
                    <FieldLabelWrap>
                      <FieldLabel>{t("mocks.bodyRequestLabel")}</FieldLabel>
                      <Textarea
                        rows={5}
                        value={editor.mock.requestBody}
                        onChange={(event) =>
                          setEditor({
                            ...editor,
                            mock: { ...editor.mock, requestBody: event.target.value },
                          })
                        }
                      />
                    </FieldLabelWrap>
                  )}

                  <div className="grid gap-2 xl:grid-cols-2">
                    <FieldLabelWrap>
                      <FieldLabel>{t("mocks.headersRequestLabel")}</FieldLabel>
                      <Textarea
                        rows={4}
                        placeholder={"Authorization: Bearer ...\nX-Tenant: demo"}
                        value={editor.requestHeadersText}
                        onChange={(event) => setEditor({ ...editor, requestHeadersText: event.target.value })}
                      />
                    </FieldLabelWrap>
                    <FieldLabelWrap>
                      <FieldLabel>{t("mocks.headersResponseLabel")}</FieldLabel>
                      <Textarea
                        rows={4}
                        placeholder="Content-Type: application/json"
                        value={editor.responseHeadersText}
                        onChange={(event) => setEditor({ ...editor, responseHeadersText: event.target.value })}
                      />
                    </FieldLabelWrap>
                  </div>

                  <div className="grid gap-2 xl:grid-cols-[minmax(0,1fr)_180px]">
                    <FieldLabelWrap>
                      <FieldLabel>{t("mocks.bodyResponseLabel")}</FieldLabel>
                      <Textarea
                        rows={7}
                        value={editor.mock.responseBody}
                        onChange={(event) =>
                          setEditor({
                            ...editor,
                            mock: { ...editor.mock, responseBody: event.target.value },
                          })
                        }
                      />
                    </FieldLabelWrap>
                    <FieldGroup>
                      <FieldLabelWrap>
                        <FieldLabel>{t("mocks.reasonLabel")}</FieldLabel>
                        <Input
                          value={editor.mock.responseReasonPhrase}
                          onChange={(event) =>
                            setEditor({
                              ...editor,
                              mock: {
                                ...editor.mock,
                                responseReasonPhrase: event.target.value,
                              },
                            })
                          }
                        />
                      </FieldLabelWrap>
                      <FieldLabelWrap>
                        <FieldLabel>{t("mocks.notesLabel")}</FieldLabel>
                        <Textarea
                          rows={4}
                          value={editor.mock.notes ?? ""}
                          onChange={(event) =>
                            setEditor({
                              ...editor,
                              mock: { ...editor.mock, notes: event.target.value },
                            })
                          }
                        />
                      </FieldLabelWrap>
                    </FieldGroup>
                  </div>

                  {error ? <p className="text-[11px] text-danger">{error}</p> : null}
                </div>
              </div>
            </>
          ) : (
            <div className="flex h-full min-h-[220px] items-center justify-center px-4">
              <EmptyState
                title={t("mocks.noMockSelected")}
                description={t("mocks.noMockSelectedDesc")}
              />
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
