import type { ComponentType } from "react";
import { ElementalSandbox } from "@/components/ElementalSandbox";
import { CelShading } from "@/components/demos/CelShading";
import { CompilerPipeline } from "@/components/demos/CompilerPipeline";
import { FareBreakdown } from "@/components/demos/FareBreakdown";
import { GrammarBreakdown } from "@/components/demos/GrammarBreakdown";
import { NodeGraphTranslator } from "@/components/demos/NodeGraphTranslator";
import { PipelineStepper } from "@/components/demos/PipelineStepper";
import { ProductMatcher } from "@/components/demos/ProductMatcher";
import { PromptAssembly } from "@/components/demos/PromptAssembly";
import { ReceiptSplitter } from "@/components/demos/ReceiptSplitter";
import { ScannerEvasion } from "@/components/demos/ScannerEvasion";
import { SourceRanking } from "@/components/demos/SourceRanking";
import { StrategyBacktest } from "@/components/demos/StrategyBacktest";
import { StylizedShading } from "@/components/demos/StylizedShading";

/*
  Interactive demos, keyed so an entry in content/work.ts can list the ones it
  carries. Every one of these ports real logic out of the project it belongs
  to — constants, formulas and control flow lifted from the actual source.
  None of them call the network; the site is a static export.
*/
export type DemoKey =
  | "elemental-sandbox"
  | "cel-shading"
  | "compiler-pipeline"
  | "fare-breakdown"
  | "grammar-breakdown"
  | "node-graph"
  | "pipeline-stepper"
  | "product-matcher"
  | "prompt-assembly"
  | "receipt-splitter"
  | "scanner-evasion"
  | "source-ranking"
  | "strategy-backtest"
  | "stylized-shading";

export const demos: Record<DemoKey, ComponentType> = {
  "elemental-sandbox": ElementalSandbox,
  "cel-shading": CelShading,
  "compiler-pipeline": CompilerPipeline,
  "fare-breakdown": FareBreakdown,
  "grammar-breakdown": GrammarBreakdown,
  "node-graph": NodeGraphTranslator,
  "pipeline-stepper": PipelineStepper,
  "product-matcher": ProductMatcher,
  "prompt-assembly": PromptAssembly,
  "receipt-splitter": ReceiptSplitter,
  "scanner-evasion": ScannerEvasion,
  "source-ranking": SourceRanking,
  "strategy-backtest": StrategyBacktest,
  "stylized-shading": StylizedShading,
};
