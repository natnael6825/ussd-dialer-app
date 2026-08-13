import { requireNativeModule } from 'expo-modules-core';

type UssdDialerModule = {
  getSubscriptions(): Promise<Array<{
    id: number;
    slotIndex: number;
    displayName: string;
    carrierName: string;
  }>>;
  send(code: string, subscriptionId: number): Promise<string>;
  isAccessibilityEnabled(): Promise<boolean>;
  openAccessibilitySettings(): Promise<void>;
  startAutomation(code: string, replies: string[], subscriptionId: number, flowName: string): Promise<void>;
  cancelAutomation(): Promise<void>;
  startRecording(code: string, subscriptionId: number): Promise<void>;
  finishRecording(): Promise<{ status: string; code: string; subscriptionId: number; replies: string[]; updatedAt: number }>;
  getRecording(): Promise<{ status: string; code: string; subscriptionId: number; replies: string[]; updatedAt: number }>;
  acknowledgeRecording(updatedAt: number): Promise<void>;
  clearPendingRecording(): Promise<void>;
  getSavedFlows(): Promise<Array<{
    id: string;
    name: string;
    code: string;
    replies: string[];
    subscriptionId: number;
    updatedAt: number;
  }>>;
  saveFlow(name: string, code: string, replies: string[], subscriptionId: number): Promise<void>;
  deleteFlow(id: string): Promise<void>;
  getResponseHistory(): Promise<Array<{
    id: string;
    startedAt: number;
    endedAt: number;
    flowName: string;
    code: string;
    subscriptionId: number;
    status: string;
    entries: Array<{
      timestamp: number;
      stepIndex: number;
      reply: string;
      response: string;
      action: string;
    }>;
  }>>;
  clearResponseHistory(): Promise<void>;
  openDialer(code: string): Promise<void>;
};

export default requireNativeModule<UssdDialerModule>('UssdDialer');
