// @ts-nocheck
import { Page } from "../../understudy/page.js";
import { ModelConfiguration } from "../public/model.js";
import type { BrowserCoreZodSchema } from "../../zodCompat.js";


export interface ActHandlerParams {
  instruction: string;
  model?: ModelConfiguration;
  variables?: Variables;
  timeout?: number;
  page: Page;
}

export interface ExtractHandlerParams<T extends BrowserCoreZodSchema> {
  instruction?: string;
  schema?: T;
  model?: ModelConfiguration;
  timeout?: number;
  selector?: string;
  page: Page;
}

export interface ObserveHandlerParams {
  instruction?: string;
  model?: ModelConfiguration;
  variables?: Variables;
  timeout?: number;
  selector?: string;
  page: Page;
}

// We can use this enum to list the actions supported in performUnderstudyMethod
export enum SupportedUnderstudyAction {
  CLICK = "click",
  FILL = "fill",
  TYPE = "type",
  PRESS = "press",
  SCROLL = "scrollTo",
  NEXT_CHUNK = "nextChunk",
  PREV_CHUNK = "prevChunk",
  SELECT_OPTION_FROM_DROPDOWN = "selectOptionFromDropdown",
  HOVER = "hover",
  DOUBLE_CLICK = "doubleClick",
  DRAG_AND_DROP = "dragAndDrop",
}
