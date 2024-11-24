import {
  actTools,
  buildActSystemPrompt,
  buildActUserPrompt,
  buildAskSystemPrompt,
  buildExtractSystemPrompt,
  buildExtractUserPrompt,
  buildObserveSystemPrompt,
  buildObserveUserMessage,
  buildAskUserPrompt,
  buildVerifyActCompletionSystemPrompt,
  buildVerifyActCompletionUserPrompt,
  buildRefineSystemPrompt,
  buildRefineUserPrompt,
  buildMetadataSystemPrompt,
  buildMetadataPrompt,
} from "./prompt";
import { z } from "zod";
import { AvailableModel, LLMProvider } from "./llm/LLMProvider";
import { LLMClient } from "./llm/LLMClient";
import { AnnotatedScreenshotText, ChatMessage } from "./llm/LLMClient";
import { resolveLLMClient } from "./llm/LLMProvider";

export async function verifyActCompletion({
  goal,
  steps,
  llmClient: initllmClient,
  llmProvider,
  modelName,
  screenshot,
  domElements,
  logger,
  requestId,
}: {
  goal: string;
  steps: string;
  llmClient: LLMClient;
  llmProvider?: LLMProvider;
  modelName?: AvailableModel;
  screenshot?: Buffer;
  domElements?: string;
  logger: (message: { category?: string; message: string }) => void;
  requestId: string;
}): Promise<boolean> {
  const llmClient =
    initllmClient || resolveLLMClient({ llmProvider, modelName });

  const messages: ChatMessage[] = [
    buildVerifyActCompletionSystemPrompt(),
    buildVerifyActCompletionUserPrompt(goal, steps, domElements),
  ];

  const response = await llmClient.createChatCompletion({
    options: {
      model: modelName,
      messages,
      temperature: 0.1,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
      image: screenshot
        ? {
            buffer: screenshot,
            description: "This is a screenshot of the whole visible page.",
          }
        : undefined,
      response_model: {
        name: "Verification",
        schema: z.object({
          completed: z.boolean().describe("true if the goal is accomplished"),
        }),
      },
    },
    requestId,
  });

  if (!response || typeof response !== "object") {
    logger({
      category: "VerifyAct",
      message: "Unexpected response format: " + JSON.stringify(response),
    });
    return false;
  }

  if (response.completed === undefined) {
    logger({
      category: "VerifyAct",
      message: "Missing 'completed' field in response",
    });
    return false;
  }

  return response.completed;
}

export function fillInVariables(
  text: string,
  variables: Record<string, string>,
) {
  let processedText = text;
  Object.entries(variables).forEach(([key, value]) => {
    const placeholder = `<|${key.toUpperCase()}|>`;
    processedText = processedText.replace(placeholder, value);
  });
  return processedText;
}

export async function act({
  action,
  domElements,
  steps,
  llmClient: initllmClient,
  llmProvider,
  modelName,
  screenshot,
  retries = 0,
  logger,
  requestId,
  variables,
}: {
  action: string;
  steps?: string;
  domElements: string;
  llmClient: LLMClient;
  llmProvider?: LLMProvider;
  modelName?: AvailableModel;
  screenshot?: Buffer;
  retries?: number;
  logger: (message: { category?: string; message: string }) => void;
  requestId: string;
  variables?: Record<string, string>;
}): Promise<{
  method: string;
  element: number;
  args: any[];
  completed: boolean;
  step: string;
  why?: string;
} | null> {
  const llmClient =
    initllmClient || resolveLLMClient({ llmProvider, modelName });

  const messages: ChatMessage[] = [
    buildActSystemPrompt(),
    buildActUserPrompt(action, steps, domElements, variables),
  ];

  const response = await llmClient.createChatCompletion({
    options: {
      model: modelName,
      messages,
      temperature: 0.1,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
      tool_choice: "auto",
      tools: actTools,
      image: screenshot
        ? { buffer: screenshot, description: AnnotatedScreenshotText }
        : undefined,
    },
    requestId,
  });

  const toolCalls = response.choices[0].message.tool_calls;

  if (toolCalls && toolCalls.length > 0) {
    if (toolCalls[0].function.name === "skipSection") {
      return null;
    }

    return JSON.parse(toolCalls[0].function.arguments);
  } else {
    if (retries >= 2) {
      logger({
        category: "Act",
        message: "No tool calls found in response",
      });
      return null;
    }

    return act({
      action,
      domElements,
      steps,
      llmClient,
      llmProvider,
      modelName,
      retries: retries + 1,
      logger,
      requestId,
    });
  }
}

export async function extract({
  instruction,
  progress,
  previouslyExtractedContent,
  domElements,
  schema,
  llmClient: initllmClient,
  llmProvider,
  modelName,
  chunksSeen,
  chunksTotal,
  requestId,
}: {
  instruction: string;
  progress: string;
  previouslyExtractedContent: any;
  domElements: string;
  schema: z.ZodObject<any>;
  llmClient: LLMClient;
  llmProvider?: LLMProvider;
  modelName?: AvailableModel;
  chunksSeen: number;
  chunksTotal: number;
  requestId: string;
}) {
  const llmClient =
    initllmClient || resolveLLMClient({ llmProvider, modelName });

  const extractionResponse = await llmClient.createChatCompletion({
    options: {
      model: modelName,
      messages: [
        buildExtractSystemPrompt(),
        buildExtractUserPrompt(instruction, domElements),
      ],
      response_model: {
        schema: schema,
        name: "Extraction",
      },
      temperature: 0.1,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    },
    requestId,
  });

  const refinedResponse = await llmClient.createChatCompletion({
    options: {
      model: modelName,
      messages: [
        buildRefineSystemPrompt(),
        buildRefineUserPrompt(
          instruction,
          previouslyExtractedContent,
          extractionResponse,
        ),
      ],
      response_model: {
        schema: schema,
        name: "RefinedExtraction",
      },
      temperature: 0.1,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    },
    requestId,
  });

  const metadataSchema = z.object({
    progress: z
      .string()
      .describe(
        "progress of what has been extracted so far, as concise as possible",
      ),
    completed: z
      .boolean()
      .describe(
        "true if the goal is now accomplished. Use this conservatively, only when you are sure that the goal has been completed.",
      ),
  });

  const metadataResponse = await llmClient.createChatCompletion({
    options: {
      model: modelName,
      messages: [
        buildMetadataSystemPrompt(),
        buildMetadataPrompt(
          instruction,
          refinedResponse,
          chunksSeen,
          chunksTotal,
        ),
      ],
      response_model: {
        name: "Metadata",
        schema: metadataSchema,
      },
      temperature: 0.1,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    },
    requestId,
  });

  refinedResponse.metadata = metadataResponse;

  return refinedResponse;
}

export async function observe({
  instruction,
  domElements,
  llmClient: initllmClient,
  llmProvider,
  modelName,
  image,
  requestId,
}: {
  instruction: string;
  domElements: string;
  llmClient: LLMClient;
  llmProvider?: LLMProvider;
  modelName?: AvailableModel;
  image?: Buffer;
  requestId: string;
}): Promise<{
  elements: { elementId: number; description: string }[];
}> {
  const observeSchema = z.object({
    elements: z
      .array(
        z.object({
          elementId: z.number().describe("the number of the element"),
          description: z
            .string()
            .describe(
              "a description of the element and what it is relevant for",
            ),
        }),
      )
      .describe("an array of elements that match the instruction"),
  });

  const llmClient =
    initllmClient || resolveLLMClient({ llmProvider, modelName });

  const observationResponse = await llmClient.createChatCompletion({
    options: {
      model: modelName,
      messages: [
        buildObserveSystemPrompt(),
        buildObserveUserMessage(instruction, domElements),
      ],
      image: image
        ? { buffer: image, description: AnnotatedScreenshotText }
        : undefined,
      response_model: {
        schema: observeSchema,
        name: "Observation",
      },
      temperature: 0.1,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    },
    requestId,
  });

  if (!observationResponse) {
    throw new Error("no response when finding a selector");
  }

  return observationResponse;
}

export async function ask({
  question,
  llmClient: initllmClient,
  llmProvider,
  modelName,
  requestId,
}: {
  question: string;
  llmClient: LLMClient;
  llmProvider?: LLMProvider;
  modelName?: AvailableModel;
  requestId: string;
}) {
  const llmClient =
    initllmClient || resolveLLMClient({ llmProvider, modelName });

  const response = await llmClient.createChatCompletion({
    options: {
      model: modelName,
      messages: [buildAskSystemPrompt(), buildAskUserPrompt(question)],
      temperature: 0.1,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    },
    requestId,
  });

  // The parsing is now handled in the LLM clients
  return response.choices[0].message.content;
}
