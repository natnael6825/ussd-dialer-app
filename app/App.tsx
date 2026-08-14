import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import {
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
  Manrope_800ExtraBold,
  useFonts,
} from '@expo-google-fonts/manrope';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  Image,
  KeyboardAvoidingView,
  Linking,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import UssdDialer, { type SafeBackendJob } from './modules/ussd-dialer';

type RunState = 'idle' | 'dialing' | 'answered' | 'failed';
type RunMode = 'none' | 'test' | 'automation';
type BusyAction = 'starting' | 'stopping' | 'recording' | 'saving' | 'deleting' | 'clearing' | 'dismissing' | null;
type SimOption = {
  id: number;
  slotIndex: number;
  displayName: string;
  carrierName: string;
};
type SavedFlow = {
  id: string;
  name: string;
  code: string;
  replies: string[];
  requiredVariables?: string[];
  subscriptionId: number;
  updatedAt: number;
};
type HistoryEntry = {
  timestamp: number;
  stepIndex: number;
  reply: string;
  response: string;
  action: string;
};
type HistorySession = {
  id: string;
  startedAt: number;
  endedAt: number;
  flowName: string;
  code: string;
  subscriptionId: number;
  status: string;
  entries: HistoryEntry[];
};
type AppView = 'build' | 'saved' | 'queue' | 'history';
type PermissionState = 'checking' | 'granted' | 'missing' | 'blocked';
type RecordingResult = {
  status: string;
  code: string;
  subscriptionId: number;
  replies: string[];
  updatedAt: number;
};
type AutomationResult = {
  status: string;
  sessionId: string;
  flowName: string;
  code: string;
  subscriptionId: number;
  currentStep: number;
  totalSteps: number;
  updatedAt: number;
  message: string;
};
type BackendStatus = {
  configured: boolean;
  running: boolean;
  connected: boolean;
  baseUrl: string;
  deviceId: string;
  deviceName: string;
  state: string;
  lastError: string;
  lastContactAt: number;
  pendingJobId: string;
};

const EMPTY_AUTOMATION: AutomationResult = {
  status: 'idle',
  sessionId: '',
  flowName: '',
  code: '',
  subscriptionId: -1,
  currentStep: 0,
  totalSteps: 0,
  updatedAt: 0,
  message: '',
};

const ACTIVE_AUTOMATION_STATUSES = new Set(['starting', 'running', 'waiting', 'sending', 'stopping']);
const CALM_AUTOMATION_STATUSES = new Set(['idle', 'reviewed']);
const VARIABLE_STEP_PATTERN = /^\{\{([a-z][a-z0-9_]{0,31})\}\}$/;
const SENSITIVE_VARIABLE_NAMES = new Set(['pin', 'password', 'passcode', 'otp', 'secret']);

function errorMessage(caught: unknown, fallback: string) {
  return caught instanceof Error && caught.message.trim() ? caught.message : fallback;
}

function flowVariables(replies: string[]) {
  return [...new Set(replies.map((reply) => reply.trim().match(VARIABLE_STEP_PATTERN)?.[1]).filter((value): value is string => !!value))].sort();
}

function invalidVariableStep(replies: string[]) {
  return replies.find((reply) => reply.includes('{{') || reply.includes('}}'))?.trim() ?? '';
}

function backendStateLabel(status: BackendStatus | null) {
  if (!status?.configured) return 'SETUP REQUIRED';
  if (status.state === 'auth_expired') return 'RECONNECT';
  if (!status.running) return 'PAUSED';
  if (status.connected) return 'ONLINE';
  if (status.pendingJobId) return 'JOB QUEUED';
  return 'CONNECTING';
}

function queueStatusLabel(status: string) {
  return status.replace(/_/g, ' ').toUpperCase();
}

function queueTimestamp(timestamp: number) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'Unknown';
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function automationStatusTitle(status: string) {
  switch (status) {
    case 'completed': return 'Flow completed';
    case 'cancelled': return 'Flow cancelled';
    case 'timed_out': return 'Carrier timed out';
    case 'interrupted':
    case 'interrupted_pending':
    case 'window_interrupted':
    case 'response_changed': return 'Flow interrupted safely';
    case 'stopped': return 'Flow stopped';
    case 'replaced': return 'Previous flow stopped';
    case 'needs_attention': return 'Manual action needed';
    case 'close_failed': return 'Flow completed';
    case 'failed':
    case 'failed_to_start':
    case 'action_failed':
    case 'send_failed':
    case 'cancel_failed':
    case 'cancel_control_not_found':
    case 'storage_error': return 'Flow could not continue';
    default: return 'Flow ended';
  }
}

function historyStatusLabel(status: string) {
  if (status === 'timed_out') return 'TIMEOUT';
  if (['interrupted', 'interrupted_pending', 'window_interrupted', 'response_changed', 'replaced'].includes(status)) return 'INTERRUPTED';
  if (['needs_attention', 'unexpected_end'].includes(status)) return 'ATTENTION';
  if (['failed', 'failed_to_start', 'action_failed', 'send_failed', 'cancel_failed', 'cancel_control_not_found', 'close_failed', 'storage_error'].includes(status)) return 'FAILED';
  return status.replace(/_/g, ' ').toUpperCase();
}

function historyActionLabel(entry: HistoryEntry) {
  if (entry.action === 'cancel') return 'CANCELLED AFTER RESPONSE';
  if (entry.action === 'complete') return 'FINAL RESPONSE';
  if (entry.action === 'ended') return 'SESSION ENDED';
  if (entry.action === 'failed') return 'CARRIER FAILURE';
  return entry.reply ? `REPLIED ${entry.reply}` : 'RESPONSE CAPTURED';
}

const COLORS = {
  ink: '#111713',
  paper: '#F4F5F1',
  surface: '#FEFFFC',
  soft: '#E9EEE9',
  green: '#153F32',
  greenSoft: '#D9ECD9',
  lime: '#C8F1B7',
  orange: '#F4774B',
  orangeSoft: '#FBE7DF',
  muted: '#738078',
  line: '#E0E5E0',
  white: '#FEFFFC',
  red: '#B94B3B',
};

function normalizeCode(value: string) {
  const trimmed = value.replace(/\s/g, '');
  if (!trimmed) return '';
  return `${trimmed.startsWith('*') ? '' : '*'}${trimmed.replace(/#$/, '')}#`;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <UssdFlowApp />
    </SafeAreaProvider>
  );
}

function UssdFlowApp() {
  const insets = useSafeAreaInsets();
  const [fontsLoaded] = useFonts({
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
    Manrope_800ExtraBold,
  });
  const [code, setCode] = useState('*667#');
  const [steps, setSteps] = useState(['1', '3', '1']);
  const [state, setState] = useState<RunState>('idle');
  const [runMode, setRunMode] = useState<RunMode>('none');
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [response, setResponse] = useState('');
  const [error, setError] = useState('');
  const [recoveryError, setRecoveryError] = useState('');
  const [nextIndex, setNextIndex] = useState(0);
  const [simOptions, setSimOptions] = useState<SimOption[]>([]);
  const [selectedSimId, setSelectedSimId] = useState<number | null>(null);
  const [simError, setSimError] = useState('');
  const [loadingSims, setLoadingSims] = useState(true);
  const [simPermission, setSimPermission] = useState<PermissionState>('checking');
  const [callPermission, setCallPermission] = useState<PermissionState>('checking');
  const [permissionsReady, setPermissionsReady] = useState(false);
  const [permissionRequesting, setPermissionRequesting] = useState<'sim' | 'call' | null>(null);
  const [accessibilityEnabled, setAccessibilityEnabled] = useState(false);
  const [activeView, setActiveView] = useState<AppView>('build');
  const [flowName, setFlowName] = useState('');
  const [savedFlows, setSavedFlows] = useState<SavedFlow[]>([]);
  const [history, setHistory] = useState<HistorySession[]>([]);
  const [libraryLoaded, setLibraryLoaded] = useState(false);
  const [libraryError, setLibraryError] = useState('');
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingStatusKnown, setRecordingStatusKnown] = useState(false);
  const [recordingSyncError, setRecordingSyncError] = useState('');
  const [automation, setAutomation] = useState<AutomationResult>(EMPTY_AUTOMATION);
  const [automationStatusKnown, setAutomationStatusKnown] = useState(false);
  const [backendStatus, setBackendStatus] = useState<BackendStatus | null>(null);
  const [backendStatusKnown, setBackendStatusKnown] = useState(false);
  const [backendUrl, setBackendUrl] = useState('');
  const [backendEnrollmentKey, setBackendEnrollmentKey] = useState('');
  const [backendDeviceName, setBackendDeviceName] = useState('USSD phone');
  const [backendBusy, setBackendBusy] = useState(false);
  const [backendSetupError, setBackendSetupError] = useState('');
  const [showBackendSettings, setShowBackendSettings] = useState(false);
  const [backendJobs, setBackendJobs] = useState<SafeBackendJob[]>([]);
  const [queueLoaded, setQueueLoaded] = useState(false);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueError, setQueueError] = useState('');
  const [deletingJobId, setDeletingJobId] = useState<string | null>(null);
  const responseOpacity = useRef(new Animated.Value(0)).current;
  const handledRecordingAt = useRef(0);
  const operationLock = useRef(false);
  const directRequestId = useRef(0);
  const reconcileInFlight = useRef<Promise<void> | null>(null);
  const queueRequestInFlight = useRef(0);
  const queueRequestSequence = useRef(0);
  const queueRequestGeneration = useRef(0);
  const queueBackendIdentity = useRef('');
  const queueMutationInFlight = useRef(false);
  const operationActiveRef = useRef(false);

  const routeSummary = useMemo(
    () => [normalizeCode(code), ...steps.map((step) => step.trim()).filter(Boolean)].join('  →  '),
    [code, steps],
  );
  const currentVariables = useMemo(() => flowVariables(steps), [steps]);
  const valid = selectedSimId !== null && normalizeCode(code).length >= 3 && steps.some((step) => step.trim());
  const setupReady = permissionsReady
    && simPermission === 'granted'
    && callPermission === 'granted'
    && accessibilityEnabled;
  const missingPermissionCount = permissionsReady
    ? Number(simPermission !== 'granted')
      + Number(callPermission !== 'granted')
      + Number(!accessibilityEnabled)
    : 0;
  const automationActive = ACTIVE_AUTOMATION_STATUSES.has(automation.status);
  const automationTerminal = automationStatusKnown
    && !automationActive
    && !CALM_AUTOMATION_STATUSES.has(automation.status);
  const operationActive = runMode !== 'none' || automationActive || isRecording || busyAction !== null || deletingJobId !== null;
  operationActiveRef.current = operationActive;
  const operationsReady = automationStatusKnown && recordingStatusKnown;
  const recordActionDisabled = busyAction !== null || (!isRecording && (
    !normalizeCode(code)
    || selectedSimId === null
    || !setupReady
    || !operationsReady
    || runMode !== 'none'
    || automationActive
  ));

  useEffect(() => {
    syncBackendStatus();
    reconcileApp();
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        syncBackendStatus();
        reconcileApp();
      }
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!automationActive || busyAction === 'starting') return undefined;
    const timer = setInterval(() => {
      Promise.all([syncAutomation(), loadLibrary()]).catch(() => undefined);
    }, 1800);
    return () => clearInterval(timer);
  }, [automationActive, busyAction]);

  useEffect(() => {
    if (!backendStatus?.configured) return undefined;
    const timer = setInterval(() => syncBackendStatus(), 5000);
    return () => clearInterval(timer);
  }, [backendStatus?.configured]);

  useEffect(() => {
    if (activeView !== 'queue' || !backendStatus?.configured) return undefined;
    loadBackendJobs();
    const timer = setInterval(() => loadBackendJobs(true), 5000);
    return () => clearInterval(timer);
  }, [activeView, backendStatus?.configured]);

  async function reconcileApp() {
    if (reconcileInFlight.current) return reconcileInFlight.current;
    const task = (async () => {
      await refreshPermissionStatus();
      await Promise.all([loadLibrary(), syncRecording(), syncAutomation()]);
    })();
    reconcileInFlight.current = task;
    try {
      await task;
    } finally {
      if (reconcileInFlight.current === task) reconcileInFlight.current = null;
    }
  }

  function backendQueueIdentityFor(status: BackendStatus) {
    return status.configured ? `${status.baseUrl}\n${status.deviceId}` : '';
  }

  function invalidateBackendQueue(clearRows = false) {
    queueRequestGeneration.current += 1;
    queueRequestInFlight.current = 0;
    setQueueLoading(false);
    if (clearRows) {
      setBackendJobs([]);
      setQueueLoaded(false);
      setQueueError('');
    }
  }

  async function syncBackendStatus() {
    try {
      const status = await UssdDialer.getBackendStatus();
      const nextQueueIdentity = backendQueueIdentityFor(status);
      if (queueBackendIdentity.current && queueBackendIdentity.current !== nextQueueIdentity) {
        invalidateBackendQueue(true);
      }
      queueBackendIdentity.current = nextQueueIdentity;
      setBackendStatus(status);
      setBackendStatusKnown(true);
      setBackendUrl((current) => current || status.baseUrl);
      setBackendDeviceName((current) => current === 'USSD phone' ? (status.deviceName || current) : current);
      if (status.configured) setBackendSetupError(status.lastError || '');
    } catch (caught) {
      setBackendStatusKnown(true);
      setBackendSetupError(errorMessage(caught, 'Could not read the backend connection state.'));
    }
  }

  async function loadBackendJobs(silent = false) {
    if (queueMutationInFlight.current || queueRequestInFlight.current !== 0) return;
    if (typeof UssdDialer.getBackendJobs !== 'function') {
      setQueueLoaded(true);
      setQueueError('Queue controls are not available in this installed build. Install the updated app to manage remote requests.');
      return;
    }
    const requestId = ++queueRequestSequence.current;
    const requestGeneration = queueRequestGeneration.current;
    const requestIdentity = queueBackendIdentity.current;
    queueRequestInFlight.current = requestId;
    if (!silent) setQueueLoading(true);
    try {
      const jobs = await UssdDialer.getBackendJobs();
      if (
        requestGeneration !== queueRequestGeneration.current
        || requestIdentity !== queueBackendIdentity.current
        || queueMutationInFlight.current
      ) return;
      setBackendJobs(Array.isArray(jobs) ? [...jobs].sort((left, right) => left.createdAt - right.createdAt) : []);
      setQueueError('');
      setQueueLoaded(true);
    } catch (caught) {
      if (
        requestGeneration !== queueRequestGeneration.current
        || requestIdentity !== queueBackendIdentity.current
        || queueMutationInFlight.current
      ) return;
      setQueueLoaded(true);
      setQueueError(errorMessage(caught, 'The remote queue could not be loaded. No request was changed.'));
    } finally {
      if (queueRequestInFlight.current === requestId) {
        queueRequestInFlight.current = 0;
        if (!silent) setQueueLoading(false);
      }
    }
  }

  function deleteBackendJob(job: SafeBackendJob) {
    if (job.status !== 'queued' || deletingJobId) return;
    Alert.alert(
      'Delete queued request?',
      `${job.flowName || 'This remote flow'} has not been delivered to the phone. Deleting it prevents this queued request from starting.`,
      [
        { text: 'Keep request', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            if (queueMutationInFlight.current) return;
            if (typeof UssdDialer.deleteBackendJob !== 'function') {
              setQueueError('Queue controls are not available in this installed build. Install the updated app to manage remote requests.');
              return;
            }
            queueMutationInFlight.current = true;
            invalidateBackendQueue();
            setDeletingJobId(job.id);
            setQueueError('');
            let requestFinished = false;
            try {
              await UssdDialer.deleteBackendJob(job.id);
              requestFinished = true;
              setBackendJobs((current) => current.filter((item) => item.id !== job.id));
              await syncBackendStatus();
            } catch (caught) {
              requestFinished = true;
              setQueueError(errorMessage(caught, 'The queued request could not be deleted. It may already have reached the phone.'));
            } finally {
              queueMutationInFlight.current = false;
              setDeletingJobId(null);
            }
            if (requestFinished) await loadBackendJobs(true);
          },
        },
      ],
    );
  }

  async function ensureNotificationPermission() {
    if (Platform.OS !== 'android' || Number(Platform.Version) < 33) return true;
    const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
    if (await PermissionsAndroid.check(permission)) return true;
    const result = await PermissionsAndroid.request(permission, {
      title: 'Keep remote dialing visible',
      message: 'USSD Flow shows a permanent notification while it listens for requests from your backend.',
      buttonPositive: 'Allow',
      buttonNegative: 'Not now',
    });
    return result === PermissionsAndroid.RESULTS.GRANTED;
  }

  async function connectBackend() {
    if (backendBusy || queueMutationInFlight.current) return;
    if (!backendUrl.trim() || !backendEnrollmentKey.trim() || !backendDeviceName.trim()) {
      setBackendSetupError('Enter the backend URL, enrollment key, and a name for this phone.');
      return;
    }
    setBackendBusy(true);
    setBackendSetupError('');
    let queueInvalidated = false;
    let reloadQueue = false;
    try {
      if (backendStatus?.pendingJobId && backendStatus.state !== 'auth_expired') {
        throw new Error('Wait for the pending backend request to finish before changing this connection.');
      }
      if (!(await ensureNotificationPermission())) {
        throw new Error('Notification access is required so background listening always remains visible and can be stopped.');
      }
      queueMutationInFlight.current = true;
      invalidateBackendQueue(true);
      queueInvalidated = true;
      if (backendStatus?.running) {
        await UssdDialer.stopBackendListener();
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      await UssdDialer.configureBackend(
        backendUrl.trim(),
        backendEnrollmentKey.trim(),
        backendDeviceName.trim(),
      );
      await UssdDialer.startBackendListener();
      setBackendEnrollmentKey('');
      setShowBackendSettings(false);
      await syncBackendStatus();
      reloadQueue = activeView === 'queue' && !!queueBackendIdentity.current;
    } catch (caught) {
      if (queueInvalidated) {
        await syncBackendStatus();
        reloadQueue = activeView === 'queue' && !!queueBackendIdentity.current;
      }
      setBackendSetupError(errorMessage(caught, 'Could not connect this phone to the backend. Check the URL and key.'));
    } finally {
      if (queueInvalidated) queueMutationInFlight.current = false;
      setBackendBusy(false);
    }
    if (reloadQueue) await loadBackendJobs(true);
  }

  async function toggleBackendListener() {
    if (backendBusy || !backendStatus?.configured) return;
    setBackendBusy(true);
    setBackendSetupError('');
    try {
      if (backendStatus.running) {
        await UssdDialer.stopBackendListener();
      } else {
        if (!(await ensureNotificationPermission())) {
          throw new Error('Notification access is required before background listening can start.');
        }
        await UssdDialer.startBackendListener();
      }
      await syncBackendStatus();
    } catch (caught) {
      setBackendSetupError(errorMessage(caught, 'Could not change the backend listener state.'));
    } finally {
      setBackendBusy(false);
    }
  }

  function forgetBackend() {
    Alert.alert(
      'Disconnect this backend?',
      'Remote requests will stop. Saved flows and local history will remain on this phone.',
      [
        { text: 'Keep connected', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: async () => {
            if (queueMutationInFlight.current) return;
            queueMutationInFlight.current = true;
            invalidateBackendQueue(true);
            setBackendBusy(true);
            let reloadQueue = false;
            try {
              if (backendStatus?.running) {
                await UssdDialer.stopBackendListener();
                await new Promise((resolve) => setTimeout(resolve, 400));
              }
              await UssdDialer.clearBackendConfiguration();
              setBackendStatus(null);
              setBackendUrl('');
              setBackendEnrollmentKey('');
              setShowBackendSettings(false);
              await syncBackendStatus();
            } catch (caught) {
              await syncBackendStatus();
              reloadQueue = activeView === 'queue' && !!queueBackendIdentity.current;
              setBackendSetupError(errorMessage(caught, 'Could not remove the backend configuration.'));
            } finally {
              queueMutationInFlight.current = false;
              setBackendBusy(false);
            }
            if (reloadQueue) await loadBackendJobs(true);
          },
        },
      ],
    );
  }

  async function refreshPermissionStatus() {
    if (Platform.OS !== 'android') {
      setPermissionsReady(true);
      return;
    }

    try {
      const [canReadSim, canCall, canAutomate] = await Promise.all([
        PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE).catch(() => false),
        PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.CALL_PHONE).catch(() => false),
        UssdDialer.isAccessibilityEnabled().catch(() => false),
      ]);
      setSimPermission((current) => (canReadSim ? 'granted' : current === 'blocked' ? 'blocked' : 'missing'));
      setCallPermission((current) => (canCall ? 'granted' : current === 'blocked' ? 'blocked' : 'missing'));
      setAccessibilityEnabled(canAutomate);
      if (canReadSim) {
        await loadSimOptions();
      } else {
        setLoadingSims(false);
        setSimOptions([]);
        setSelectedSimId(null);
        setSimError('Allow SIM access from the setup banner above.');
      }
    } catch {
      setSimPermission((current) => (current === 'blocked' ? 'blocked' : 'missing'));
      setCallPermission((current) => (current === 'blocked' ? 'blocked' : 'missing'));
      setAccessibilityEnabled(false);
      setLoadingSims(false);
    } finally {
      setPermissionsReady(true);
    }
  }

  async function loadLibrary() {
    try {
      const [flows, entries] = await Promise.all([
        UssdDialer.getSavedFlows(),
        UssdDialer.getResponseHistory(),
      ]);
      setSavedFlows(flows);
      setHistory(entries);
      setLibraryLoaded(true);
      setLibraryError('');
      if (backendStatus?.configured) {
        UssdDialer.syncBackendCatalog().catch(() => undefined);
      }
    } catch (caught) {
      setLibraryError(errorMessage(caught, 'Saved flows and session history could not be loaded. Your existing data was not changed.'));
    }
  }

  async function syncAutomation() {
    try {
      const result = await UssdDialer.getAutomationStatus();
      setAutomation(result);
      setAutomationStatusKnown(true);
      if (ACTIVE_AUTOMATION_STATUSES.has(result.status)) {
        setRunMode('automation');
        setState('idle');
      } else {
        setRunMode((current) => (current === 'automation' ? 'none' : current));
      }
    } catch (caught) {
      setAutomationStatusKnown(false);
      setRecoveryError(errorMessage(caught, 'Could not confirm whether a flow is still active. Retry before starting another flow.'));
    }
  }

  async function syncRecording() {
    try {
      const recording = await UssdDialer.getRecording();
      setRecordingStatusKnown(true);
      setRecordingSyncError('');
      setIsRecording(recording.status === 'recording');
      if (
        recording.status === 'reviewed' &&
        recording.updatedAt > handledRecordingAt.current
      ) {
        handledRecordingAt.current = recording.updatedAt;
        applyRecording(recording, false);
        return;
      }
      if (
        recording.status !== 'idle' &&
        recording.status !== 'recording' &&
        recording.status !== 'reviewed'
      ) {
        if (recording.updatedAt > handledRecordingAt.current) {
          handledRecordingAt.current = recording.updatedAt;
          applyRecording(recording);
        }
        try {
          await UssdDialer.acknowledgeRecording(recording.updatedAt);
        } catch (caught) {
          setRecoveryError(errorMessage(caught, 'The recording was recovered, but its review state could not be saved.'));
        }
      }
    } catch (caught) {
      setRecordingStatusKnown(false);
      setRecordingSyncError(errorMessage(caught, 'Could not confirm whether recording is still active.'));
    }
  }

  function applyRecording(recording: RecordingResult, showNotice = true) {
    if (recording.code) setCode(recording.code);
    if (recording.subscriptionId >= 0) setSelectedSimId(recording.subscriptionId);
    if (recording.replies.length) setSteps(recording.replies);
    if (!showNotice) return;
    const count = recording.replies.length;
    const partial = ['cancelled', 'timed_out', 'interrupted', 'failed', 'stopped'].includes(recording.status);
    const title = recording.status === 'timed_out'
      ? 'Recording timed out'
      : recording.status === 'interrupted'
        ? 'Recording interrupted'
        : recording.status === 'failed'
          ? 'Recording stopped by an error'
          : count ? (partial ? 'Partial flow recovered' : 'Flow recorded') : 'Nothing recorded';
    const detail = count
      ? `${count} confirmed ${count === 1 ? 'reply was' : 'replies were'} preserved. Review the steps, name the flow, then save it.`
      : 'No confirmed menu replies were captured. Your existing draft was kept; you can try recording again.';
    Alert.alert(title, detail);
  }

  async function loadSimOptions() {
    if (Platform.OS !== 'android') return;
    setLoadingSims(true);
    setSimError('');
    try {
      const subscriptions = await UssdDialer.getSubscriptions();
      setSimOptions(subscriptions);
      setSelectedSimId((current) => (
        subscriptions.some((subscription) => subscription.id === current)
          ? current
          : subscriptions.length === 1 ? subscriptions[0].id : null
      ));
      if (!subscriptions.length) setSimError('No active SIM card was found.');
    } catch (caught) {
      setSimError(caught instanceof Error ? caught.message : 'Could not read the active SIM cards.');
    } finally {
      setLoadingSims(false);
    }
  }

  function updateStep(index: number, value: string) {
    setSteps((current) => current.map((step, i) => (i === index ? value : step)));
  }

  function useVariableStep(index: number) {
    setSteps((current) => current.map((step, i) => {
      if (i !== index) return step;
      const existingName = step.trim().match(VARIABLE_STEP_PATTERN)?.[1];
      return existingName ? '' : `{{value_${index + 1}}}`;
    }));
  }

  function addStep() {
    setSteps((current) => [...current, '']);
  }

  function addCancelStep() {
    setSteps((current) => [...current, 'CANCEL']);
  }

  function removeStep(index: number) {
    setSteps((current) => current.filter((_, i) => i !== index));
  }

  function clearMenuPath() {
    if (operationActive) return;
    const clearReplies = () => {
      if (operationActiveRef.current) {
        Alert.alert('Another action is active', 'Finish or stop the current action before clearing this menu path.');
        return;
      }
      setSteps(['']);
      setNextIndex(0);
    };
    if (!steps.some((step) => step.trim())) {
      clearReplies();
      return;
    }
    Alert.alert(
      'Clear this menu path?',
      'Recorded, loaded, and typed replies in the current draft will be cleared. The starting code, flow name, SIM, saved flows, history, and backend connection will stay unchanged.',
      [
        { text: 'Keep path', style: 'cancel' },
        { text: 'Clear path', style: 'destructive', onPress: clearReplies },
      ],
    );
  }

  async function ensurePhonePermission() {
    if (Platform.OS !== 'android') return false;
    try {
      const [canReadSim, canCall] = await Promise.all([
        PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE),
        PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.CALL_PHONE),
      ]);
      setSimPermission((current) => (canReadSim ? 'granted' : current === 'blocked' ? 'blocked' : 'missing'));
      setCallPermission((current) => (canCall ? 'granted' : current === 'blocked' ? 'blocked' : 'missing'));
      setPermissionsReady(true);
      if (!canReadSim || !canCall) {
        Alert.alert('Finish setup', 'Use the permission banner at the top of the app to allow SIM access and USSD calling.');
        return false;
      }
      return true;
    } catch (caught) {
      setRecoveryError(errorMessage(caught, 'Android could not confirm the phone permissions. Retry before dialing.'));
      return false;
    }
  }

  async function requestSimPermission() {
    if (permissionRequesting) return;
    setPermissionRequesting('sim');
    try {
      const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE, {
        title: 'Allow SIM access',
        message: 'USSD Flow uses this access to show your active SIM cards and dial with the one you choose.',
        buttonPositive: 'Allow',
        buttonNegative: 'Not now',
      });
      if (result === PermissionsAndroid.RESULTS.GRANTED) {
        setSimPermission('granted');
        await loadSimOptions();
        return;
      }
      setSimPermission(result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN ? 'blocked' : 'missing');
      setLoadingSims(false);
    } catch {
      Alert.alert('Permission unavailable', 'Android could not open the SIM permission request. Try App settings instead.');
    } finally {
      setPermissionRequesting(null);
    }
  }

  async function requestCallPermission() {
    if (permissionRequesting) return;
    setPermissionRequesting('call');
    try {
      const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CALL_PHONE, {
        title: 'Allow USSD calling',
        message: 'USSD Flow needs calling access to start the USSD request you choose.',
        buttonPositive: 'Allow',
        buttonNegative: 'Not now',
      });
      setCallPermission(
        result === PermissionsAndroid.RESULTS.GRANTED
          ? 'granted'
          : result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN ? 'blocked' : 'missing',
      );
    } catch {
      Alert.alert('Permission unavailable', 'Android could not open the calling permission request. Try App settings instead.');
    } finally {
      setPermissionRequesting(null);
    }
  }

  async function openAppPermissionSettings() {
    try {
      await Linking.openSettings();
    } catch {
      Alert.alert('Settings unavailable', 'Open Android Settings, choose Apps, then USSD Flow to enable access.');
    }
  }

  function beginExclusiveOperation() {
    if (operationLock.current || operationActive) {
      Alert.alert('Another action is active', 'Stop or finish the current flow before starting a new one.');
      return false;
    }
    operationLock.current = true;
    return true;
  }

  function endExclusiveOperation() {
    operationLock.current = false;
    setBusyAction(null);
  }

  async function dial(request: string, guided: boolean) {
    if (Number(Platform.Version) < 26) {
      Alert.alert(
        'Direct test needs Android 8',
        'This phone can still record and play flows. Only the direct response test is unavailable on Android 7.',
      );
      return;
    }
    if (selectedSimId === null) {
      Alert.alert('Choose a SIM', 'Select the SIM card to use before dialing.');
      return;
    }
    if (!operationsReady) {
      Alert.alert('Checking active sessions', 'Wait a moment while USSD Flow confirms that no recording or automation is still active.');
      return;
    }
    if (!beginExclusiveOperation()) return;
    setBusyAction('starting');
    const requestId = ++directRequestId.current;
    const allowed = await ensurePhonePermission();
    if (!allowed) {
      endExclusiveOperation();
      return;
    }

    setBusyAction(null);
    setRunMode('test');
    setState('dialing');
    setResponse('');
    setError('');
    responseOpacity.setValue(0);
    if (guided) setNextIndex(0);

    try {
      const carrierResponse = await UssdDialer.send(normalizeCode(request), selectedSimId);
      if (requestId !== directRequestId.current) return;
      setResponse(carrierResponse);
      setState('answered');
      Animated.timing(responseOpacity, {
        toValue: 1,
        duration: 360,
        useNativeDriver: true,
      }).start();
    } catch (caught) {
      if (requestId !== directRequestId.current) return;
      const message = errorMessage(caught, 'The carrier did not return a response. Check your signal and try again.');
      setError(message);
      setState('failed');
      Animated.timing(responseOpacity, {
        toValue: 1,
        duration: 240,
        useNativeDriver: true,
      }).start();
    } finally {
      if (requestId === directRequestId.current) {
        setRunMode('none');
        endExclusiveOperation();
      }
    }
  }

  async function openPhoneDialer() {
    try {
      await UssdDialer.openDialer(normalizeCode(code));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Could not open the phone dialer.';
      Alert.alert('Dialer unavailable', message);
    }
  }

  async function openAccessibilitySetup() {
    try {
      await UssdDialer.openAccessibilitySettings();
    } catch {
      Alert.alert('Settings unavailable', 'Open Android Settings, choose Accessibility, then enable USSD Flow automation.');
    }
  }

  async function startStepByStep(flow?: Pick<SavedFlow, 'name' | 'code' | 'replies' | 'subscriptionId'>) {
    const runCode = flow?.code ?? code;
    const runSteps = flow?.replies ?? steps;
    const runSimId = flow?.subscriptionId ?? selectedSimId;
    const runName = flow?.name ?? (flowName.trim() || 'Unsaved flow');
    if (!permissionsReady || !setupReady) {
      Alert.alert('Finish setup', 'Allow the missing access from the setup banner before running a flow.');
      return;
    }
    if (runSimId === null) {
      Alert.alert('Choose a SIM', 'Select the SIM card to use before starting.');
      return;
    }
    if (!simOptions.some((sim) => sim.id === runSimId)) {
      Alert.alert('Saved SIM unavailable', 'This flow was saved for a SIM that is not currently active. Edit it and choose an available SIM.');
      return;
    }
    const cleanSteps = runSteps.map((step) => step.trim()).filter(Boolean);
    const requiredVariables = flowVariables(cleanSteps);
    if (!accessibilityEnabled) {
      Alert.alert('Automation access needed', 'Enable Step automation from the setup banner at the top of the app.');
      return;
    }
    if (!operationsReady) {
      Alert.alert('Checking active sessions', 'Wait a moment, then try again.');
      return;
    }
    if (!cleanSteps.length) {
      Alert.alert('Flow incomplete', 'Add at least one reply or a CANCEL step before playing this flow.');
      return;
    }
    if (requiredVariables.length) {
      Alert.alert(
        'Variables required',
        `This flow expects ${requiredVariables.map((name) => `{{${name}}}`).join(', ')}. Start it through the backend API with those values.`,
      );
      return;
    }
    if (!beginExclusiveOperation()) return;
    setBusyAction('starting');
    setRunMode('automation');
    if (!(await ensurePhonePermission())) {
      setRunMode('none');
      endExclusiveOperation();
      return;
    }
    try {
      setAutomation({
        ...EMPTY_AUTOMATION,
        status: 'starting',
        flowName: runName,
        code: normalizeCode(runCode),
        subscriptionId: runSimId,
        totalSteps: cleanSteps.length,
        updatedAt: Date.now(),
        message: 'Opening the carrier USSD session…',
      });
      setState('idle');
      setResponse('');
      setError('');
      await UssdDialer.startAutomation(normalizeCode(runCode), cleanSteps, runSimId, runName);
      await syncAutomation();
      await loadLibrary();
    } catch (caught) {
      setRunMode('none');
      const message = errorMessage(caught, 'Could not start step-by-step dialing. Nothing was sent.');
      setAutomation((current) => ({ ...current, status: 'failed_to_start', updatedAt: Date.now(), message }));
      setRecoveryError(message);
      setError(message);
      await syncAutomation();
    } finally {
      endExclusiveOperation();
    }
  }

  async function startFlowRecording() {
    if (!permissionsReady || !setupReady) {
      Alert.alert('Finish setup', 'Allow the missing access from the setup banner before recording.');
      return;
    }
    if (selectedSimId === null) {
      Alert.alert('Choose a SIM', 'Select the SIM card to use before recording.');
      return;
    }
    if (!accessibilityEnabled) {
      Alert.alert('Automation access needed', 'Enable Step automation from the setup banner before recording.');
      return;
    }
    if (!operationsReady) {
      Alert.alert('Checking active sessions', 'Wait a moment, then try again.');
      return;
    }
    if (!beginExclusiveOperation()) return;
    setBusyAction('recording');
    if (!(await ensurePhonePermission())) {
      endExclusiveOperation();
      return;
    }
    try {
      await UssdDialer.startRecording(normalizeCode(code), selectedSimId);
      setIsRecording(true);
      setRecordingStatusKnown(true);
      setRecordingSyncError('');
    } catch (caught) {
      setIsRecording(false);
      Alert.alert('Recording failed', errorMessage(caught, 'Could not start the USSD recorder. Nothing was changed.'));
      await syncRecording();
    } finally {
      endExclusiveOperation();
    }
  }

  async function stopFlowRecording() {
    if (operationLock.current || busyAction !== null) return;
    operationLock.current = true;
    setBusyAction('recording');
    try {
      const recording = await UssdDialer.finishRecording();
      setIsRecording(false);
      setRecordingStatusKnown(true);
      handledRecordingAt.current = recording.updatedAt;
      applyRecording(recording);
      try {
        await UssdDialer.acknowledgeRecording(recording.updatedAt);
      } catch (caught) {
        setRecoveryError(errorMessage(caught, 'The replies were recovered, but the review state could not be saved.'));
      }
    } catch (caught) {
      setRecoveryError(errorMessage(caught, 'Could not stop recording safely. USSD Flow will check its state again.'));
      await syncRecording();
    } finally {
      endExclusiveOperation();
    }
  }

  async function saveCurrentFlow() {
    if (!flowName.trim()) {
      Alert.alert('Name this flow', 'Enter a short name so you can find and play it later.');
      return;
    }
    if (selectedSimId === null || !valid) {
      Alert.alert('Flow incomplete', 'Choose a SIM and add the starting code and replies first.');
      return;
    }
    const malformedVariable = invalidVariableStep(steps);
    if (malformedVariable && !VARIABLE_STEP_PATTERN.test(malformedVariable)) {
      Alert.alert('Invalid variable', 'A variable must be the entire reply and use a name like {{phone}} or {{amount}}. Names use lowercase letters, numbers, and underscores.');
      return;
    }
    const sensitiveVariable = flowVariables(steps).find((name) => SENSITIVE_VARIABLE_NAMES.has(name));
    if (sensitiveVariable) {
      Alert.alert('Keep secrets on the phone', `{{${sensitiveVariable}}} cannot be supplied remotely. Save a secret such as a PIN as a local literal step so the backend never receives it.`);
      return;
    }
    if (!beginExclusiveOperation()) return;
    setBusyAction('saving');
    try {
      await UssdDialer.saveFlow(flowName.trim(), normalizeCode(code), steps, selectedSimId);
      await UssdDialer.clearPendingRecording();
      await loadLibrary();
      setActiveView('saved');
    } catch (caught) {
      setRecoveryError(errorMessage(caught, 'The flow could not be saved. Your draft is still here—try again.'));
    } finally {
      endExclusiveOperation();
    }
  }

  function editSavedFlow(flow: SavedFlow) {
    setFlowName(flow.name);
    setCode(flow.code);
    setSteps(flow.replies.length ? flow.replies : ['']);
    setSelectedSimId(flow.subscriptionId);
    setActiveView('build');
  }

  function deleteSavedFlow(flow: SavedFlow) {
    Alert.alert('Delete saved flow?', `${flow.name} will be removed from this phone.`, [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          if (operationLock.current || operationActive) return;
          operationLock.current = true;
          setBusyAction('deleting');
          try {
            await UssdDialer.deleteFlow(flow.id);
            await loadLibrary();
          } catch (caught) {
            setRecoveryError(errorMessage(caught, 'The saved flow could not be deleted. It remains on this phone.'));
          } finally {
            endExclusiveOperation();
          }
        },
      },
    ]);
  }

  function clearHistory() {
    Alert.alert('Clear session history?', 'This removes every recorded session from this phone.', [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: async () => {
          if (operationLock.current || operationActive) return;
          operationLock.current = true;
          setBusyAction('clearing');
          try {
            await UssdDialer.clearResponseHistory();
            setHistory([]);
          } catch (caught) {
            setRecoveryError(errorMessage(caught, 'Session history could not be cleared. No history was intentionally removed.'));
            await loadLibrary();
          } finally {
            endExclusiveOperation();
          }
        },
      },
    ]);
  }

  async function cancelStepByStep() {
    if (operationLock.current || busyAction !== null) return;
    operationLock.current = true;
    setBusyAction('stopping');
    try {
      await UssdDialer.cancelAutomation();
    } catch (caught) {
      setRecoveryError(errorMessage(caught, 'Could not confirm the stop request. Check the carrier dialog and try Stop again.'));
    } finally {
      await syncAutomation();
      await loadLibrary();
      endExclusiveOperation();
    }
  }

  async function dismissAutomationResult() {
    if (operationLock.current || automationActive) return;
    operationLock.current = true;
    setBusyAction('dismissing');
    try {
      await UssdDialer.acknowledgeAutomation(automation.updatedAt);
      setAutomation(EMPTY_AUTOMATION);
      setRunMode('none');
    } catch (caught) {
      setRecoveryError(errorMessage(caught, 'The result could not be dismissed. It is safe to leave it and try again later.'));
    } finally {
      endExclusiveOperation();
    }
  }

  const nextReply = steps[nextIndex]?.trim();
  const queuedJobCount = backendJobs.filter((job) => job.status === 'queued').length;
  const visibleRecoveryError = recoveryError || recordingSyncError || libraryError || (backendStatus?.configured ? backendSetupError : '');
  const automationProgress = automation.totalSteps > 0
    ? `${Math.min(automation.currentStep, automation.totalSteps)} of ${automation.totalSteps} replies sent`
    : 'Waiting for the carrier';

  if (!fontsLoaded || !backendStatusKnown) {
    return (
      <View style={styles.loadingScreen}>
        <Image source={require('./assets/ussd-flow-logo.png')} style={styles.loadingLogo} />
        <ActivityIndicator color={COLORS.green} />
      </View>
    );
  }

  if (!backendStatus?.configured || showBackendSettings) {
    return (
      <SafeAreaView edges={['top', 'left', 'right', 'bottom']} style={styles.backendSetupScreen}>
        <StatusBar style="dark" />
        <ScrollView contentContainerStyle={styles.backendSetupPage} keyboardShouldPersistTaps="handled">
          <View style={styles.backendSetupBrand}>
            <Image source={require('./assets/ussd-flow-logo.png')} style={styles.backendSetupLogo} />
            <Text style={styles.backendSetupKicker}>REMOTE DIALING SETUP</Text>
            <Text style={styles.backendSetupTitle}>{backendStatus?.configured ? 'Change backend.' : 'Connect this phone.'}</Text>
            <Text style={styles.backendSetupIntro}>USSD Flow makes an outbound, authenticated connection to your Node backend. The phone never opens an inbound internet port.</Text>
          </View>

          <View style={styles.backendSetupCard}>
            <Text style={styles.backendFieldLabel}>BACKEND URL</Text>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              onChangeText={setBackendUrl}
              placeholder="https://api.example.com"
              placeholderTextColor="#8A9790"
              style={styles.backendInput}
              value={backendUrl}
            />
            <Text style={styles.backendFieldHelp}>Use HTTPS in production. Local HTTP is accepted only by a debug build.</Text>

            <Text style={styles.backendFieldLabel}>DEVICE NAME</Text>
            <TextInput
              maxLength={64}
              onChangeText={setBackendDeviceName}
              placeholder="Office USSD phone"
              placeholderTextColor="#8A9790"
              style={styles.backendInput}
              value={backendDeviceName}
            />

            <Text style={styles.backendFieldLabel}>ENROLLMENT KEY</Text>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setBackendEnrollmentKey}
              placeholder="From backend/.env"
              placeholderTextColor="#8A9790"
              secureTextEntry
              style={styles.backendInput}
              value={backendEnrollmentKey}
            />
            <Text style={styles.backendFieldHelp}>Used once to enroll this phone. The stored device credential is encrypted by Android Keystore.</Text>

            {!!backendSetupError && (
              <View style={styles.backendSetupError}><Ionicons name="warning-outline" size={17} color={COLORS.red} /><Text style={styles.backendSetupErrorText}>{backendSetupError}</Text></View>
            )}

            <Pressable disabled={backendBusy} onPress={connectBackend} style={({ pressed }) => [styles.backendConnectButton, backendBusy && styles.disabled, pressed && styles.primaryPressed]}>
              {backendBusy ? <ActivityIndicator color={COLORS.white} /> : <Ionicons name="link-outline" size={19} color={COLORS.white} />}
              <Text style={styles.backendConnectText}>{backendBusy ? 'Connecting securely' : 'Connect phone'}</Text>
            </Pressable>
            {backendStatus?.configured && (
              <>
                <Pressable disabled={backendBusy} onPress={() => { setShowBackendSettings(false); setBackendSetupError(''); }} style={styles.backendCancelButton}>
                  <Text style={styles.backendCancelText}>Keep current backend</Text>
                </Pressable>
                <Pressable disabled={backendBusy} onPress={forgetBackend} style={styles.backendDisconnectButton}>
                  <Text style={styles.backendDisconnectText}>Disconnect backend</Text>
                </Pressable>
              </>
            )}
          </View>

          <View style={styles.backendSafetyNote}>
            <Ionicons name="lock-closed-outline" size={18} color={COLORS.green} />
            <Text style={styles.backendSafetyText}>When the phone is securely locked, a request is held only until its short expiry and runs after unlock. Android does not allow this app to bypass the lock screen.</Text>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.appShell}>
          <ScrollView
            style={styles.flex}
            contentContainerStyle={[styles.page, { paddingBottom: 124 + insets.bottom }]}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.header}>
              <View style={styles.brandGroup}>
                <Image source={require('./assets/ussd-flow-logo.png')} style={styles.brandMark} />
                <View>
                  <Text style={styles.brandName}>USSD Flow</Text>
                  <Text style={styles.brandTagline}>Personal dial assistant</Text>
                </View>
              </View>
              <Pressable accessibilityLabel="Open automation settings" onPress={openAccessibilitySetup} style={({ pressed }) => [styles.settingsButton, pressed && styles.pressed]}>
                <View style={[styles.statusDot, setupReady && styles.statusDotReady]} />
                <Ionicons name="settings-outline" size={20} color={COLORS.ink} />
              </Pressable>
            </View>

            <View style={[styles.backendStatusCard, backendStatus.connected && styles.backendStatusCardOnline]}>
              <View style={[styles.backendStatusIcon, backendStatus.connected && styles.backendStatusIconOnline]}>
                <Ionicons name={backendStatus.connected ? 'cloud-done-outline' : backendStatus.running ? 'cloud-outline' : 'cloud-offline-outline'} size={19} color={COLORS.green} />
              </View>
              <View style={styles.backendStatusCopy}>
                <View style={styles.backendStatusTitleRow}>
                  <Text style={styles.backendStatusTitle}>Backend listener</Text>
                  <Text style={[styles.backendStatusPill, backendStatus.connected && styles.backendStatusPillOnline]}>{backendStateLabel(backendStatus)}</Text>
                </View>
                <Text numberOfLines={1} style={styles.backendStatusUrl}>{backendStatus.baseUrl}</Text>
                <Text selectable numberOfLines={1} style={styles.backendDeviceId}>DEVICE  {backendStatus.deviceId}</Text>
                {!!backendStatus.pendingJobId && <Text style={styles.backendPendingText}>A request is queued and will expire if it cannot run safely.</Text>}
                {!!backendStatus.lastError && <Text numberOfLines={2} style={styles.backendStatusError}>{backendStatus.lastError}</Text>}
              </View>
              <View style={styles.backendStatusActions}>
                <Pressable accessibilityLabel={backendStatus.running ? 'Pause backend listener' : 'Start backend listener'} disabled={backendBusy} onPress={toggleBackendListener} style={styles.backendStatusAction}>
                  {backendBusy ? <ActivityIndicator size="small" color={COLORS.green} /> : <Ionicons name={backendStatus.running ? 'pause' : 'play'} size={16} color={COLORS.green} />}
                </Pressable>
                <Pressable accessibilityLabel="Manage backend connection" disabled={backendBusy} onPress={() => { setBackendUrl(backendStatus.baseUrl); setBackendDeviceName(backendStatus.deviceName); setBackendEnrollmentKey(''); setBackendSetupError(''); setShowBackendSettings(true); }} style={styles.backendStatusAction}>
                  <Ionicons name="create-outline" size={16} color={COLORS.green} />
                </Pressable>
              </View>
            </View>

            {permissionsReady && missingPermissionCount > 0 && (
              <View style={styles.permissionBanner}>
                <View style={styles.permissionBannerHeader}>
                  <View style={styles.permissionBannerIcon}>
                    <Ionicons name="shield-outline" size={21} color={COLORS.red} />
                  </View>
                  <View style={styles.permissionBannerHeading}>
                    <Text accessibilityLiveRegion="polite" accessibilityRole="header" style={styles.permissionBannerTitle}>Finish setup</Text>
                    <Text style={styles.permissionBannerCopy}>Allow the missing access below before running a flow.</Text>
                  </View>
                  <View style={styles.permissionCountPill}>
                    <Text style={styles.permissionCountText}>{missingPermissionCount} LEFT</Text>
                  </View>
                </View>

                {simPermission !== 'granted' && (
                  <View style={styles.permissionRow}>
                    <View style={styles.permissionRowIcon}><Ionicons name="card-outline" size={17} color={COLORS.green} /></View>
                    <View style={styles.permissionRowCopy}>
                      <Text style={styles.permissionRowTitle}>SIM access</Text>
                      <Text style={styles.permissionRowDescription}>Choose which active SIM should dial.</Text>
                    </View>
                    <Pressable
                      accessibilityLabel={simPermission === 'blocked' ? 'Open app settings for SIM access' : 'Allow SIM access'}
                      accessibilityRole="button"
                      disabled={permissionRequesting !== null}
                      onPress={simPermission === 'blocked' ? openAppPermissionSettings : requestSimPermission}
                      style={({ pressed }) => [styles.permissionAction, permissionRequesting !== null && styles.permissionActionBusy, pressed && styles.primaryPressed]}
                    >
                      {permissionRequesting === 'sim'
                        ? <ActivityIndicator color={COLORS.white} size="small" />
                        : <Text style={styles.permissionActionText}>{simPermission === 'blocked' ? 'Settings' : 'Allow'}</Text>}
                    </Pressable>
                  </View>
                )}

                {callPermission !== 'granted' && (
                  <View style={styles.permissionRow}>
                    <View style={styles.permissionRowIcon}><Ionicons name="call-outline" size={17} color={COLORS.green} /></View>
                    <View style={styles.permissionRowCopy}>
                      <Text style={styles.permissionRowTitle}>USSD calling</Text>
                      <Text style={styles.permissionRowDescription}>Start only the USSD request you choose.</Text>
                    </View>
                    <Pressable
                      accessibilityLabel={callPermission === 'blocked' ? 'Open app settings for USSD calling' : 'Allow USSD calling'}
                      accessibilityRole="button"
                      disabled={permissionRequesting !== null}
                      onPress={callPermission === 'blocked' ? openAppPermissionSettings : requestCallPermission}
                      style={({ pressed }) => [styles.permissionAction, permissionRequesting !== null && styles.permissionActionBusy, pressed && styles.primaryPressed]}
                    >
                      {permissionRequesting === 'call'
                        ? <ActivityIndicator color={COLORS.white} size="small" />
                        : <Text style={styles.permissionActionText}>{callPermission === 'blocked' ? 'Settings' : 'Allow'}</Text>}
                    </Pressable>
                  </View>
                )}

                {!accessibilityEnabled && (
                  <View style={styles.permissionRow}>
                    <View style={styles.permissionRowIcon}><Ionicons name="git-branch-outline" size={17} color={COLORS.green} /></View>
                    <View style={styles.permissionRowCopy}>
                      <Text style={styles.permissionRowTitle}>Step automation</Text>
                      <Text style={styles.permissionRowDescription}>Wait for each response, then send the next reply.</Text>
                    </View>
                    <Pressable
                      accessibilityLabel="Enable step automation"
                      accessibilityRole="button"
                      onPress={openAccessibilitySetup}
                      style={({ pressed }) => [styles.permissionAction, pressed && styles.primaryPressed]}
                    >
                      <Text style={styles.permissionActionText}>Enable</Text>
                    </Pressable>
                  </View>
                )}
              </View>
            )}

            {automationActive && (
              <View accessibilityLiveRegion="polite" style={styles.operationBanner}>
                <View style={styles.operationPulse}><ActivityIndicator color={COLORS.green} size="small" /></View>
                <View style={styles.operationCopy}>
                  <Text style={styles.operationEyebrow}>ACTIVE FLOW</Text>
                  <Text numberOfLines={1} style={styles.operationTitle}>{automation.flowName || 'USSD flow'}</Text>
                  <Text style={styles.operationDescription}>{automation.message || automationProgress}</Text>
                  <Text style={styles.operationProgress}>{automationProgress}</Text>
                </View>
                <Pressable
                  accessibilityLabel="Stop active USSD flow"
                  disabled={busyAction === 'stopping'}
                  onPress={cancelStepByStep}
                  style={({ pressed }) => [styles.operationStop, pressed && styles.pressed]}
                >
                  {busyAction === 'stopping'
                    ? <ActivityIndicator color={COLORS.red} size="small" />
                    : <><Ionicons name="stop" size={14} color={COLORS.red} /><Text style={styles.operationStopText}>Stop</Text></>}
                </Pressable>
              </View>
            )}

            {automationTerminal && (
              <View accessibilityLiveRegion="polite" style={[styles.operationBanner, styles.operationBannerTerminal]}>
                <View style={[styles.operationPulse, styles.operationTerminalIcon]}>
                  <Ionicons name={automation.status === 'completed' ? 'checkmark' : 'alert'} size={17} color={automation.status === 'completed' ? COLORS.green : COLORS.red} />
                </View>
                <View style={styles.operationCopy}>
                  <Text style={styles.operationEyebrow}>LAST SESSION</Text>
                  <Text style={styles.operationTitle}>{automationStatusTitle(automation.status)}</Text>
                  <Text style={styles.operationDescription}>{automation.message || `${automationProgress}. Confirm the carrier dialog is closed before retrying.`}</Text>
                </View>
                <Pressable disabled={busyAction === 'dismissing'} onPress={dismissAutomationResult} style={styles.operationDismiss}>
                  {busyAction === 'dismissing' ? <ActivityIndicator color={COLORS.green} size="small" /> : <Ionicons name="close" size={19} color={COLORS.green} />}
                </Pressable>
              </View>
            )}

            {!!visibleRecoveryError && (
              <View style={styles.recoveryBanner}>
                <View style={styles.recoveryIcon}><Ionicons name="warning-outline" size={18} color={COLORS.red} /></View>
                <View style={styles.recoveryCopy}><Text style={styles.recoveryTitle}>Action needs attention</Text><Text style={styles.recoveryText}>{visibleRecoveryError}</Text></View>
                <Pressable
                  accessibilityLabel="Retry app status check"
                  onPress={() => { setRecoveryError(''); setRecordingSyncError(''); setLibraryError(''); reconcileApp(); }}
                  style={styles.recoveryAction}
                ><Text style={styles.recoveryActionText}>Retry</Text></Pressable>
              </View>
            )}

            {activeView === 'build' && (
              <View>
                <View style={styles.pageHeadingRow}>
                  <View style={styles.pageHeadingCopy}>
                    <Text style={styles.kicker}>CREATE A FLOW</Text>
                    <Text style={styles.pageTitle}>Build your shortcut.</Text>
                    <Text style={styles.pageSubtitle}>Set the starting code, then add each menu reply in order.</Text>
                  </View>
                  <View style={styles.stepBadge}><Text style={styles.stepBadgeText}>{steps.length}</Text></View>
                </View>

                <View style={styles.setupCard}>
                  <View style={styles.setupTopline}>
                    <Text style={styles.setupLabel}>STARTING CODE</Text>
                    <View style={styles.readyPill}>
                      <View style={[styles.readyDot, !setupReady && styles.readyDotOff]} />
                      <Text style={styles.readyText}>{permissionsReady ? (setupReady ? 'READY' : 'SETUP NEEDED') : 'CHECKING'}</Text>
                    </View>
                  </View>
                  <TextInput
                    accessibilityLabel="Starting USSD code"
                    autoCapitalize="none"
                    keyboardType="phone-pad"
                    onChangeText={setCode}
                    placeholder="*667#"
                    placeholderTextColor="#82958D"
                    selectionColor={COLORS.lime}
                    style={styles.codeInput}
                    value={code}
                  />
                  <View style={styles.setupDivider} />
                  <Text style={styles.setupLabel}>DIAL WITH</Text>
                  {loadingSims ? (
                    <View style={styles.simLoading}><ActivityIndicator size="small" color={COLORS.lime} /><Text style={styles.simLoadingText}>Reading SIM cards</Text></View>
                  ) : simOptions.length ? (
                    <View style={styles.simRow}>
                      {simOptions.map((sim) => {
                        const selected = sim.id === selectedSimId;
                        return (
                          <Pressable
                            accessibilityLabel={`Use SIM ${sim.slotIndex + 1}, ${sim.carrierName}`}
                            accessibilityRole="radio"
                            accessibilityState={{ checked: selected }}
                            key={sim.id}
                            onPress={() => {
                              setSelectedSimId(sim.id);
                              setState('idle');
                              setResponse('');
                              setError('');
                            }}
                            style={({ pressed }) => [styles.simChoice, selected && styles.simChoiceSelected, pressed && styles.pressed]}
                          >
                            <View style={[styles.simIcon, selected && styles.simIconSelected]}>
                              <Ionicons name="card-outline" size={16} color={selected ? COLORS.green : COLORS.white} />
                            </View>
                            <View style={styles.simCopy}>
                              <Text style={[styles.simSlot, selected && styles.simTextSelected]}>SIM {sim.slotIndex + 1}</Text>
                              <Text numberOfLines={1} style={[styles.simCarrier, selected && styles.simTextSelected]}>{sim.carrierName || sim.displayName}</Text>
                            </View>
                            <Ionicons name={selected ? 'checkmark-circle' : 'ellipse-outline'} size={19} color={selected ? COLORS.lime : '#799087'} />
                          </Pressable>
                        );
                      })}
                    </View>
                  ) : (
                    <Pressable
                      onPress={simPermission === 'granted' ? loadSimOptions : simPermission === 'blocked' ? openAppPermissionSettings : requestSimPermission}
                      style={styles.simErrorBox}
                    >
                      <Text style={styles.simErrorText}>{simError || 'No active SIM card found.'}</Text>
                      <Text style={styles.retryText}>{simPermission === 'granted' ? 'Try again' : simPermission === 'blocked' ? 'Open settings' : 'Allow SIM access'}</Text>
                    </Pressable>
                  )}
                </View>

                <View style={styles.sectionHeading}>
                  <View style={styles.sectionHeadingCopy}>
                    <Text style={styles.sectionTitle}>Menu path</Text>
                    <Text style={styles.sectionSubtitle}>One reply is sent after each carrier response.</Text>
                  </View>
                  <View style={styles.sectionHeadingActions}>
                    <Text style={styles.sectionCount}>{steps.length} {steps.length === 1 ? 'step' : 'steps'}</Text>
                    <Pressable
                      accessibilityLabel="Clear current menu path"
                      accessibilityHint="Clears only the reply steps in this draft"
                      disabled={operationActive}
                      onPress={clearMenuPath}
                      style={({ pressed }) => [styles.clearPathButton, operationActive && styles.disabled, pressed && styles.pressed]}
                    >
                      <Ionicons name="refresh-outline" size={14} color={COLORS.red} />
                      <Text style={styles.clearPathText}>Clear path</Text>
                    </Pressable>
                  </View>
                </View>

                <View style={styles.variableHint}>
                  <Ionicons name="code-slash-outline" size={17} color={COLORS.green} />
                  <View style={styles.variableHintCopy}>
                    <Text style={styles.variableHintTitle}>Remote values</Text>
                    <Text style={styles.variableHintText}>Make a whole reply a variable, such as {'{{phone}}'} or {'{{amount}}'}. The API must provide every value before the phone dials.</Text>
                    {!!currentVariables.length && (
                      <Text style={styles.variableHintNames}>REQUIRES  {currentVariables.join('  ·  ')}</Text>
                    )}
                  </View>
                </View>

                <View style={styles.stepsList}>
                  <View style={styles.routeRail} />
                  {steps.map((step, index) => {
                    const isCancel = step.trim().toUpperCase() === 'CANCEL';
                    const variableName = step.trim().match(VARIABLE_STEP_PATTERN)?.[1];
                    return (
                      <View key={index} style={styles.stepRow}>
                        <View style={[styles.stepDot, isCancel && styles.stepDotCancel]}>
                          <Text style={styles.stepDotText}>{index + 1}</Text>
                        </View>
                        <View style={[styles.stepField, isCancel && styles.stepFieldCancel, variableName && styles.stepFieldVariable]}>
                          <View style={styles.stepFieldTopline}>
                            <Text style={styles.stepFieldLabel}>{isCancel ? 'END SESSION' : variableName ? `VARIABLE · ${variableName}` : `REPLY ${index + 1}`}</Text>
                            {!isCancel && (
                              <Pressable accessibilityLabel={variableName ? `Remove variable from reply ${index + 1}` : `Use a variable for reply ${index + 1}`} onPress={() => useVariableStep(index)} style={styles.variableButton}>
                                <Ionicons name={variableName ? 'close' : 'code-slash'} size={12} color={COLORS.green} />
                                <Text style={styles.variableButtonText}>{variableName ? 'Plain value' : 'Variable'}</Text>
                              </Pressable>
                            )}
                          </View>
                          <TextInput
                            accessibilityLabel={`Reply ${index + 1}`}
                            autoCapitalize="none"
                            autoCorrect={false}
                            keyboardType="default"
                            maxLength={160}
                            onChangeText={(value) => updateStep(index, value)}
                            placeholder="Enter menu reply"
                            placeholderTextColor="#9AA49E"
                            selectionColor={COLORS.orange}
                            style={[styles.stepInput, isCancel && styles.stepInputCancel]}
                            value={step}
                          />
                        </View>
                        {steps.length > 1 && (
                          <Pressable accessibilityLabel={`Remove reply ${index + 1}`} hitSlop={10} onPress={() => removeStep(index)} style={({ pressed }) => [styles.removeButton, pressed && styles.pressed]}>
                            <Ionicons name="close" size={19} color={COLORS.muted} />
                          </Pressable>
                        )}
                      </View>
                    );
                  })}
                </View>

                <View style={styles.stepActions}>
                  <Pressable onPress={addStep} style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}>
                    <Ionicons name="add" size={18} color={COLORS.green} />
                    <Text style={styles.addText}>Add reply</Text>
                  </Pressable>
                  <Pressable onPress={addCancelStep} style={({ pressed }) => [styles.addCancelButton, pressed && styles.pressed]}>
                    <Ionicons name="stop-circle-outline" size={17} color={COLORS.red} />
                    <Text style={styles.addCancelText}>End with Cancel</Text>
                  </Pressable>
                </View>

                <View style={styles.routeCard}>
                  <View style={styles.routeCardTopline}>
                    <Text style={styles.routeCardLabel}>ROUTE PREVIEW</Text>
                    <Ionicons name="git-branch-outline" size={17} color={COLORS.green} />
                  </View>
                  <Text selectable style={styles.routeCode}>{routeSummary}</Text>
                </View>

                <View style={styles.saveCard}>
                  <Text style={styles.fieldLabel}>FLOW NAME</Text>
                  <View style={styles.saveRow}>
                    <TextInput
                      accessibilityLabel="Flow name"
                      onChangeText={setFlowName}
                      placeholder="e.g. Buy weekly data"
                      placeholderTextColor="#929C96"
                      selectionColor={COLORS.orange}
                      style={styles.flowNameInput}
                      value={flowName}
                    />
                    <Pressable disabled={operationActive} onPress={saveCurrentFlow} style={({ pressed }) => [styles.saveButton, operationActive && styles.disabled, pressed && styles.pressed]}>
                      {busyAction === 'saving' ? <ActivityIndicator color={COLORS.white} size="small" /> : <Ionicons name="bookmark-outline" size={17} color={COLORS.white} />}
                      <Text style={styles.saveButtonText}>{busyAction === 'saving' ? 'Saving' : 'Save'}</Text>
                    </Pressable>
                  </View>
                </View>

                <View style={styles.actionGrid}>
                  <Pressable
                    disabled={recordActionDisabled}
                    onPress={isRecording ? stopFlowRecording : startFlowRecording}
                    style={({ pressed }) => [styles.recordAction, isRecording && styles.recordActionActive, recordActionDisabled && styles.disabled, pressed && styles.primaryPressed]}
                  >
                    <View style={styles.actionIconCircle}><Ionicons name={isRecording ? 'stop' : 'radio'} size={20} color={COLORS.orange} /></View>
                    <Text style={styles.recordActionTitle}>{isRecording ? 'Stop recording' : 'Record manually'}</Text>
                    <Text style={styles.recordActionCopy}>{isRecording ? 'Return here after the USSD session.' : 'Capture the replies you enter.'}</Text>
                  </Pressable>
                  <Pressable
                    disabled={!valid || !setupReady || !operationsReady || operationActive}
                    onPress={() => startStepByStep()}
                    style={({ pressed }) => [styles.playAction, (!valid || !setupReady || !operationsReady || operationActive) && styles.disabled, pressed && styles.primaryPressed]}
                  >
                    <View style={styles.playIconCircle}>{busyAction === 'starting' ? <ActivityIndicator color={COLORS.green} size="small" /> : <Ionicons name="play" size={19} color={COLORS.green} />}</View>
                    <Text style={styles.playActionTitle}>{busyAction === 'starting' ? 'Starting safely' : 'Play this flow'}</Text>
                    <Text style={styles.playActionCopy}>Dial and reply automatically.</Text>
                  </Pressable>
                </View>

                {!!recordingSyncError && (
                  <View style={styles.inlineStatus}><Ionicons name="warning-outline" size={16} color={COLORS.red} /><Text style={styles.inlineStatusText}>Recording status is uncertain. Tap Retry above before starting anything new.</Text></View>
                )}

                <View style={styles.utilityRow}>
                  <Pressable disabled={!valid || !operationsReady || operationActive || Number(Platform.Version) < 26} onPress={() => dial(code, true)} style={({ pressed }) => [styles.utilityButton, (Number(Platform.Version) < 26 || !valid || !operationsReady || operationActive) && styles.utilityDisabled, pressed && styles.pressed]}>
                    <Ionicons name="chatbubble-ellipses-outline" size={17} color={COLORS.green} />
                    <Text style={styles.utilityText}>{Number(Platform.Version) < 26 ? 'Test needs Android 8' : 'Test starting code'}</Text>
                  </Pressable>
                  <Pressable disabled={!normalizeCode(code) || operationActive} onPress={openPhoneDialer} style={({ pressed }) => [styles.utilityButton, operationActive && styles.utilityDisabled, pressed && styles.pressed]}>
                    <Ionicons name="keypad-outline" size={17} color={COLORS.green} />
                    <Text style={styles.utilityText}>Open dialer</Text>
                  </Pressable>
                </View>

                {(state === 'answered' || state === 'failed') && (
                  <Animated.View style={[styles.responsePanel, { opacity: responseOpacity }]}>
                    <View style={styles.responseHeader}>
                      <Ionicons name={state === 'answered' ? 'cellular-outline' : 'alert-circle-outline'} size={18} color={state === 'answered' ? COLORS.lime : '#FFD3C4'} />
                      <Text style={styles.responseKicker}>{state === 'answered' ? 'NETWORK RESPONSE' : 'REQUEST FAILED'}</Text>
                    </View>
                    <Text selectable style={[styles.responseText, state === 'failed' && styles.errorText]}>{state === 'answered' ? response : error}</Text>
                    {state === 'answered' && nextReply && (
                      <View style={styles.nextReplyRow}>
                        <View><Text style={styles.nextLabel}>NEXT REPLY</Text><Text style={styles.nextValue}>{nextReply}</Text></View>
                        <Pressable onPress={() => setNextIndex((current) => Math.min(current + 1, steps.length - 1))} style={styles.doneButton}><Text style={styles.doneButtonText}>Mark entered</Text></Pressable>
                      </View>
                    )}
                  </Animated.View>
                )}

                <View style={styles.privacyNote}>
                  <Ionicons name="shield-checkmark-outline" size={19} color={COLORS.green} />
                  <Text style={styles.privacyText}>Saved codes, literal replies, carrier responses, and history stay on this phone. API variable values pass through the relay in memory but are omitted from logs and status responses.</Text>
                </View>
              </View>
            )}

            {activeView === 'saved' && (
              <View>
                <View style={styles.pageHeadingRow}>
                  <View style={styles.pageHeadingCopy}><Text style={styles.kicker}>YOUR LIBRARY</Text><Text style={styles.pageTitle}>Saved flows.</Text><Text style={styles.pageSubtitle}>Run a familiar USSD route without remembering each menu.</Text></View>
                  <View style={styles.stepBadge}><Text style={styles.stepBadgeText}>{savedFlows.length}</Text></View>
                </View>
                {!libraryLoaded && libraryError ? (
                  <View style={styles.emptyState}><View style={styles.emptyIcon}><Ionicons name="cloud-offline-outline" size={25} color={COLORS.red} /></View><Text style={styles.emptyTitle}>Could not load saved flows</Text><Text style={styles.emptyCopy}>Your data was not cleared. Tap Retry above to check again.</Text></View>
                ) : !savedFlows.length ? (
                  <View style={styles.emptyState}>
                    <View style={styles.emptyIcon}><Ionicons name="bookmark-outline" size={25} color={COLORS.green} /></View>
                    <Text style={styles.emptyTitle}>No saved flows yet</Text>
                    <Text style={styles.emptyCopy}>Create a route, give it a name, and it will be ready here.</Text>
                    <Pressable onPress={() => setActiveView('build')} style={styles.emptyButton}><Text style={styles.emptyButtonText}>Create first flow</Text><Ionicons name="arrow-forward" size={16} color={COLORS.white} /></Pressable>
                  </View>
                ) : savedFlows.map((flow, index) => {
                  const sim = simOptions.find((option) => option.id === flow.subscriptionId);
                  const variables = flow.requiredVariables?.length ? flow.requiredVariables : flowVariables(flow.replies);
                  return (
                    <View key={flow.id} style={styles.savedFlow}>
                      <View style={styles.savedTopline}>
                        <View style={styles.savedIndex}><Text style={styles.savedIndexText}>{String(index + 1).padStart(2, '0')}</Text></View>
                        <View style={styles.savedHeading}><Text style={styles.savedName}>{flow.name}</Text><Text style={styles.savedMeta}>{sim ? `SIM ${sim.slotIndex + 1}  ·  ${sim.carrierName}` : 'Saved SIM unavailable'}</Text></View>
                        <Pressable disabled={operationActive} onPress={() => deleteSavedFlow(flow)} hitSlop={8} style={[styles.iconButton, operationActive && styles.disabled]}><Ionicons name="trash-outline" size={18} color={COLORS.red} /></Pressable>
                      </View>
                      <View style={styles.savedRouteBox}>
                        <Text numberOfLines={2} style={styles.savedRoute}>{[flow.code, ...flow.replies].join('  →  ')}</Text>
                        {!!variables.length && <Text style={styles.savedVariables}>API INPUTS  {variables.join('  ·  ')}</Text>}
                      </View>
                      <View style={styles.savedActions}>
                        <Pressable disabled={operationActive} onPress={() => editSavedFlow(flow)} style={[styles.editButton, operationActive && styles.disabled]}><Ionicons name="create-outline" size={17} color={COLORS.green} /><Text style={styles.editText}>Edit</Text></Pressable>
                        <Pressable disabled={!setupReady || !operationsReady || operationActive} onPress={() => startStepByStep(flow)} style={({ pressed }) => [styles.playButton, (!setupReady || !operationsReady || operationActive) && styles.disabled, pressed && styles.primaryPressed]}><Ionicons name={variables.length ? 'cloud-outline' : 'play'} size={16} color={COLORS.green} /><Text style={styles.playButtonText}>{busyAction === 'starting' ? 'Starting' : variables.length ? 'API flow' : 'Play flow'}</Text></Pressable>
                      </View>
                    </View>
                  );
                })}
              </View>
            )}

            {activeView === 'queue' && (
              <View>
                <View style={styles.pageHeadingRow}>
                  <View style={styles.pageHeadingCopy}>
                    <Text style={styles.kicker}>REMOTE REQUESTS</Text>
                    <Text style={styles.pageTitle}>Queue.</Text>
                    <Text style={styles.pageSubtitle}>Review requests waiting on this phone without exposing their input values.</Text>
                  </View>
                  <View style={styles.queueHeadingActions}>
                    <View style={styles.stepBadge}><Text style={styles.stepBadgeText}>{backendJobs.length}</Text></View>
                    <Pressable
                      accessibilityLabel="Refresh remote queue"
                      disabled={queueLoading || deletingJobId !== null}
                      onPress={() => loadBackendJobs()}
                      style={({ pressed }) => [styles.queueRefreshButton, (queueLoading || deletingJobId !== null) && styles.disabled, pressed && styles.pressed]}
                    >
                      {queueLoading ? <ActivityIndicator size="small" color={COLORS.green} /> : <Ionicons name="refresh-outline" size={17} color={COLORS.green} />}
                    </Pressable>
                  </View>
                </View>

                <View style={styles.queuePrivacyNote}>
                  <Ionicons name="eye-off-outline" size={18} color={COLORS.green} />
                  <Text style={styles.queuePrivacyText}>Only flow and delivery metadata are shown. Variables, literal replies, carrier responses, and credentials never appear in this panel.</Text>
                </View>

                {queueLoading && !queueLoaded ? (
                  <View style={styles.emptyState}>
                    <View style={styles.emptyIcon}><ActivityIndicator color={COLORS.green} /></View>
                    <Text style={styles.emptyTitle}>Loading queue</Text>
                    <Text style={styles.emptyCopy}>Checking for remote requests assigned to this phone.</Text>
                  </View>
                ) : queueError && !backendJobs.length ? (
                  <View style={styles.emptyState}>
                    <View style={[styles.emptyIcon, styles.queueErrorIcon]}><Ionicons name="warning-outline" size={25} color={COLORS.red} /></View>
                    <Text style={styles.emptyTitle}>Queue unavailable</Text>
                    <Text style={styles.emptyCopy}>{queueError}</Text>
                    <Pressable disabled={queueLoading} onPress={() => loadBackendJobs()} style={styles.emptyButton}>
                      <Text style={styles.emptyButtonText}>Try again</Text><Ionicons name="refresh" size={16} color={COLORS.white} />
                    </Pressable>
                  </View>
                ) : !backendJobs.length ? (
                  <View style={styles.emptyState}>
                    <View style={styles.emptyIcon}><Ionicons name="layers-outline" size={25} color={COLORS.green} /></View>
                    <Text style={styles.emptyTitle}>Queue is clear</Text>
                    <Text style={styles.emptyCopy}>New backend requests will appear here while they wait for this phone.</Text>
                  </View>
                ) : (
                  <>
                    {!!queueError && (
                      <View style={styles.queueErrorBanner}>
                        <Ionicons name="warning-outline" size={17} color={COLORS.red} />
                        <Text style={styles.queueErrorText}>{queueError}</Text>
                        <Pressable onPress={() => loadBackendJobs()} hitSlop={8}><Text style={styles.queueRetryText}>Retry</Text></Pressable>
                      </View>
                    )}
                    {backendJobs.map((job) => {
                      const canDelete = job.status === 'queued';
                      const deleting = deletingJobId === job.id;
                      return (
                        <View key={job.id} style={styles.queueJobCard}>
                          <View style={styles.queueJobTopline}>
                            <View style={[styles.queueJobIcon, canDelete && styles.queueJobIconQueued]}>
                              <Ionicons name={canDelete ? 'time-outline' : 'shield-checkmark-outline'} size={19} color={COLORS.green} />
                            </View>
                            <View style={styles.queueJobHeading}>
                              <Text numberOfLines={1} style={styles.queueJobName}>{job.flowName || 'Remote flow'}</Text>
                              <Text numberOfLines={1} style={styles.queueJobId}>REQUEST {job.id.slice(0, 8).toUpperCase()}  ·  FLOW {job.flowId}</Text>
                            </View>
                            <View style={[styles.queueStatusPill, !canDelete && styles.queueStatusPillLocked]}>
                              <Text style={[styles.queueStatusText, !canDelete && styles.queueStatusTextLocked]}>{queueStatusLabel(job.status)}</Text>
                            </View>
                          </View>

                          <View style={styles.queueJobMeta}>
                            <View style={styles.queueMetaColumn}><Text style={styles.queueMetaLabel}>QUEUED</Text><Text style={styles.queueMetaValue}>{queueTimestamp(job.createdAt)}</Text></View>
                            <View style={[styles.queueMetaColumn, styles.queueMetaColumnRight]}><Text style={styles.queueMetaLabel}>EXPIRES</Text><Text style={styles.queueMetaValue}>{queueTimestamp(job.expiresAt)}</Text></View>
                          </View>

                          {canDelete ? (
                            <Pressable
                              accessibilityLabel={`Delete queued request for ${job.flowName || 'remote flow'}`}
                              disabled={deletingJobId !== null}
                              onPress={() => deleteBackendJob(job)}
                              style={({ pressed }) => [styles.queueDeleteButton, deletingJobId !== null && styles.disabled, pressed && styles.pressed]}
                            >
                              {deleting ? <ActivityIndicator size="small" color={COLORS.red} /> : <Ionicons name="trash-outline" size={16} color={COLORS.red} />}
                              <Text style={styles.queueDeleteText}>{deleting ? 'Deleting safely' : 'Delete queued request'}</Text>
                            </Pressable>
                          ) : (
                            <View style={styles.queueReadOnlyNote}>
                              <Ionicons name="lock-closed-outline" size={14} color={COLORS.muted} />
                              <Text style={styles.queueReadOnlyText}>This request has already left the deletable queue and is read-only here.</Text>
                            </View>
                          )}
                        </View>
                      );
                    })}
                  </>
                )}
              </View>
            )}

            {activeView === 'history' && (
              <View>
                <View style={styles.pageHeadingRow}>
                  <View style={styles.pageHeadingCopy}><Text style={styles.kicker}>SESSION LOG</Text><Text style={styles.pageTitle}>History.</Text><Text style={styles.pageSubtitle}>Tap a session to inspect every captured response and reply.</Text></View>
                  {!!history.length && <Pressable disabled={operationActive} onPress={clearHistory} style={[styles.clearButton, operationActive && styles.disabled]}><Ionicons name="trash-outline" size={16} color={COLORS.red} /><Text style={styles.clearText}>{busyAction === 'clearing' ? 'Clearing' : 'Clear'}</Text></Pressable>}
                </View>
                {!libraryLoaded && libraryError ? (
                  <View style={styles.emptyState}><View style={styles.emptyIcon}><Ionicons name="cloud-offline-outline" size={25} color={COLORS.red} /></View><Text style={styles.emptyTitle}>Could not load history</Text><Text style={styles.emptyCopy}>Your sessions were not cleared. Tap Retry above to check again.</Text></View>
                ) : !history.length ? (
                  <View style={styles.emptyState}><View style={styles.emptyIcon}><Ionicons name="time-outline" size={25} color={COLORS.green} /></View><Text style={styles.emptyTitle}>No sessions yet</Text><Text style={styles.emptyCopy}>Played flows and captured carrier responses will appear here.</Text></View>
                ) : (
                  <View style={styles.historyTable}>
                    <View style={styles.tableHeader}><Text style={[styles.tableHeaderText, styles.flowColumn]}>FLOW</Text><Text style={[styles.tableHeaderText, styles.dateColumn]}>DATE</Text><Text style={[styles.tableHeaderText, styles.statusColumn]}>STATUS</Text><View style={styles.chevronColumn} /></View>
                    {history.map((session) => {
                      const expanded = expandedSessionId === session.id;
                      const started = new Date(session.startedAt);
                      const sim = simOptions.find((option) => option.id === session.subscriptionId);
                      return (
                        <View key={session.id} style={[styles.historyRowGroup, expanded && styles.historyRowGroupExpanded]}>
                          <Pressable accessibilityRole="button" accessibilityState={{ expanded }} accessibilityLabel={`${session.flowName}, ${session.status}, ${session.entries.length} responses`} onPress={() => setExpandedSessionId(expanded ? null : session.id)} style={({ pressed }) => [styles.tableRow, pressed && styles.tableRowPressed]}>
                            <View style={styles.flowColumn}><Text numberOfLines={1} style={styles.tableFlow}>{session.flowName}</Text><Text numberOfLines={1} style={styles.tableCode}>{session.code} · {session.entries.length} steps</Text></View>
                            <View style={styles.dateColumn}><Text style={styles.tableDate}>{started.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</Text><Text style={styles.tableTime}>{started.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</Text></View>
                            <View style={styles.statusColumn}><View style={[styles.statusPill, session.status === 'cancelled' && styles.statusPillCancelled, session.status !== 'completed' && session.status !== 'cancelled' && styles.statusPillStopped]}><Text style={[styles.statusPillText, session.status === 'cancelled' && styles.statusPillTextCancelled, session.status !== 'completed' && session.status !== 'cancelled' && styles.statusPillTextStopped]}>{historyStatusLabel(session.status)}</Text></View></View>
                            <View style={styles.chevronColumn}><Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={17} color={COLORS.green} /></View>
                          </Pressable>
                          {expanded && (
                            <View style={styles.accordionBody}>
                              <View style={styles.sessionMetaRow}><View><Text style={styles.sessionMetaLabel}>SIM</Text><Text style={styles.sessionMetaValue}>{sim ? `SIM ${sim.slotIndex + 1} · ${sim.carrierName}` : 'Saved SIM'}</Text></View><View style={styles.sessionMetaRight}><Text style={styles.sessionMetaLabel}>DURATION</Text><Text style={styles.sessionMetaValue}>{session.endedAt > session.startedAt ? `${Math.max(1, Math.round((session.endedAt - session.startedAt) / 1000))} sec` : '—'}</Text></View></View>
                              <Text style={styles.detailHeading}>SESSION DETAILS</Text>
                              <View style={styles.sessionTimeline}>{session.entries.length ? session.entries.map((entry, index) => (
                                <View key={`${session.id}-${entry.timestamp}-${index}`} style={styles.sessionEntry}><View style={styles.timelineMarker}><Text style={styles.timelineMarkerText}>{index + 1}</Text></View><View style={styles.timelineBody}><Text selectable style={styles.historyResponse}>{entry.response}</Text><Text style={styles.historyAction}>{historyActionLabel(entry)}</Text></View></View>
                              )) : <Text style={styles.noDetailText}>No carrier response was captured in this session.</Text>}</View>
                            </View>
                          )}
                        </View>
                      );
                    })}
                  </View>
                )}
              </View>
            )}
          </ScrollView>

          <View style={[styles.bottomNav, { bottom: Math.max(13, insets.bottom) }]}>
            {([
              { view: 'build' as AppView, label: 'Create', icon: 'add-circle-outline' as const, activeIcon: 'add-circle' as const },
              { view: 'saved' as AppView, label: 'Saved', icon: 'bookmark-outline' as const, activeIcon: 'bookmark' as const },
              { view: 'queue' as AppView, label: 'Queue', icon: 'layers-outline' as const, activeIcon: 'layers' as const },
              { view: 'history' as AppView, label: 'History', icon: 'time-outline' as const, activeIcon: 'time' as const },
            ]).map((item) => {
              const selected = activeView === item.view;
              return (
                <Pressable key={item.view} onPress={() => { setActiveView(item.view); if (item.view === 'saved' || item.view === 'history') loadLibrary(); }} style={({ pressed }) => [styles.navItem, selected && styles.navItemActive, pressed && styles.pressed]}>
                  <View style={styles.navIconWrap}>
                    <Ionicons name={selected ? item.activeIcon : item.icon} size={21} color={selected ? COLORS.green : '#9AA79F'} />
                    {item.view === 'queue' && queuedJobCount > 0 && (
                      <View style={styles.navQueueBadge}><Text style={styles.navQueueBadgeText}>{Math.min(queuedJobCount, 99)}</Text></View>
                    )}
                  </View>
                  <Text style={[styles.navLabel, selected && styles.navLabelActive]}>{item.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  loadingScreen: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 18, backgroundColor: COLORS.paper },
  loadingLogo: { width: 64, height: 64, borderRadius: 20 },
  backendSetupScreen: { flex: 1, backgroundColor: COLORS.paper },
  backendSetupPage: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 22, paddingVertical: 32 },
  backendSetupBrand: { alignItems: 'center', marginBottom: 23 },
  backendSetupLogo: { width: 62, height: 62, borderRadius: 20, marginBottom: 18 },
  backendSetupKicker: { color: COLORS.orange, fontFamily: 'Manrope_800ExtraBold', fontSize: 9, letterSpacing: 1.4 },
  backendSetupTitle: { color: COLORS.ink, fontFamily: 'Manrope_800ExtraBold', fontSize: 31, letterSpacing: -1, marginTop: 8 },
  backendSetupIntro: { color: COLORS.muted, fontFamily: 'Manrope_400Regular', fontSize: 11, lineHeight: 17, textAlign: 'center', maxWidth: 360, marginTop: 8 },
  backendSetupCard: { backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.line, borderRadius: 25, padding: 18, shadowColor: '#0C2A20', shadowOpacity: 0.08, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 3 },
  backendFieldLabel: { color: COLORS.muted, fontFamily: 'Manrope_800ExtraBold', fontSize: 8, letterSpacing: 1, marginLeft: 3, marginTop: 12, marginBottom: 7 },
  backendInput: { minHeight: 52, color: COLORS.ink, backgroundColor: COLORS.paper, borderWidth: 1, borderColor: COLORS.line, borderRadius: 15, paddingHorizontal: 14, fontFamily: 'Manrope_600SemiBold', fontSize: 12 },
  backendFieldHelp: { color: COLORS.muted, fontFamily: 'Manrope_400Regular', fontSize: 8, lineHeight: 12, marginHorizontal: 3, marginTop: 5 },
  backendSetupError: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, backgroundColor: COLORS.orangeSoft, borderRadius: 13, padding: 11, marginTop: 13 },
  backendSetupErrorText: { flex: 1, color: COLORS.red, fontFamily: 'Manrope_500Medium', fontSize: 9, lineHeight: 14 },
  backendConnectButton: { height: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: COLORS.green, borderRadius: 15, marginTop: 17 },
  backendConnectText: { color: COLORS.white, fontFamily: 'Manrope_800ExtraBold', fontSize: 11 },
  backendCancelButton: { height: 43, alignItems: 'center', justifyContent: 'center', marginTop: 5 },
  backendCancelText: { color: COLORS.green, fontFamily: 'Manrope_700Bold', fontSize: 10 },
  backendDisconnectButton: { height: 40, alignItems: 'center', justifyContent: 'center', borderTopWidth: 1, borderTopColor: COLORS.line, marginTop: 2 },
  backendDisconnectText: { color: COLORS.red, fontFamily: 'Manrope_700Bold', fontSize: 9 },
  backendSafetyNote: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, backgroundColor: COLORS.greenSoft, borderRadius: 16, padding: 13, marginTop: 14 },
  backendSafetyText: { flex: 1, color: COLORS.green, fontFamily: 'Manrope_500Medium', fontSize: 9, lineHeight: 14 },
  safeArea: { flex: 1, backgroundColor: COLORS.paper },
  appShell: { flex: 1, backgroundColor: COLORS.paper },
  page: { paddingHorizontal: 18, paddingBottom: 124 },
  header: { height: 76, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brandGroup: { flexDirection: 'row', alignItems: 'center' },
  brandMark: { width: 42, height: 42, borderRadius: 14, marginRight: 11 },
  brandName: { color: COLORS.ink, fontFamily: 'Manrope_800ExtraBold', fontSize: 18, letterSpacing: -0.5 },
  brandTagline: { color: COLORS.muted, fontFamily: 'Manrope_500Medium', fontSize: 9, marginTop: 1 },
  settingsButton: { width: 43, height: 43, borderRadius: 16, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.surface, alignItems: 'center', justifyContent: 'center' },
  statusDot: { position: 'absolute', right: 7, top: 7, width: 7, height: 7, borderRadius: 4, backgroundColor: COLORS.orange, borderWidth: 1.5, borderColor: COLORS.surface, zIndex: 2 },
  statusDotReady: { backgroundColor: '#57A66B' },
  backendStatusCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.line, borderRadius: 18, padding: 11, marginBottom: 10 },
  backendStatusCardOnline: { borderColor: '#BBD9BF', backgroundColor: '#FAFFFA' },
  backendStatusIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: COLORS.soft, alignItems: 'center', justifyContent: 'center', marginRight: 9 },
  backendStatusIconOnline: { backgroundColor: COLORS.greenSoft },
  backendStatusCopy: { flex: 1, minWidth: 0 },
  backendStatusTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  backendStatusTitle: { color: COLORS.ink, fontFamily: 'Manrope_800ExtraBold', fontSize: 11 },
  backendStatusPill: { color: COLORS.muted, backgroundColor: COLORS.soft, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 3, fontFamily: 'Manrope_800ExtraBold', fontSize: 6, letterSpacing: 0.4 },
  backendStatusPillOnline: { color: COLORS.green, backgroundColor: COLORS.lime },
  backendStatusUrl: { color: COLORS.muted, fontFamily: 'Manrope_400Regular', fontSize: 8, marginTop: 3 },
  backendDeviceId: { color: COLORS.green, fontFamily: 'Manrope_700Bold', fontSize: 7, letterSpacing: 0.35, marginTop: 3 },
  backendPendingText: { color: COLORS.orange, fontFamily: 'Manrope_600SemiBold', fontSize: 7, lineHeight: 10, marginTop: 3 },
  backendStatusError: { color: COLORS.red, fontFamily: 'Manrope_500Medium', fontSize: 7, lineHeight: 10, marginTop: 3 },
  backendStatusActions: { flexDirection: 'row', gap: 4, marginLeft: 7 },
  backendStatusAction: { width: 34, height: 34, borderRadius: 11, backgroundColor: COLORS.greenSoft, alignItems: 'center', justifyContent: 'center' },
  permissionBanner: { backgroundColor: COLORS.surface, borderWidth: 1, borderColor: '#E6D8D1', borderRadius: 22, paddingHorizontal: 14, paddingTop: 14, paddingBottom: 3, marginBottom: 2, shadowColor: '#6B3828', shadowOpacity: 0.05, shadowRadius: 12, shadowOffset: { width: 0, height: 5 }, elevation: 2 },
  permissionBannerHeader: { flexDirection: 'row', alignItems: 'center', paddingBottom: 12 },
  permissionBannerIcon: { width: 38, height: 38, borderRadius: 13, backgroundColor: COLORS.orangeSoft, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  permissionBannerHeading: { flex: 1, minWidth: 0, paddingRight: 7 },
  permissionBannerTitle: { color: COLORS.ink, fontFamily: 'Manrope_800ExtraBold', fontSize: 14, letterSpacing: -0.25 },
  permissionBannerCopy: { color: COLORS.muted, fontFamily: 'Manrope_400Regular', fontSize: 9, lineHeight: 13, marginTop: 2 },
  permissionCountPill: { backgroundColor: COLORS.orangeSoft, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 6 },
  permissionCountText: { color: COLORS.red, fontFamily: 'Manrope_800ExtraBold', fontSize: 7, letterSpacing: 0.5 },
  permissionRow: { minHeight: 57, flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderTopColor: COLORS.line, paddingVertical: 10 },
  permissionRowIcon: { width: 31, height: 31, borderRadius: 10, backgroundColor: COLORS.greenSoft, alignItems: 'center', justifyContent: 'center', marginRight: 9 },
  permissionRowCopy: { flex: 1, minWidth: 0, paddingRight: 7 },
  permissionRowTitle: { color: COLORS.ink, fontFamily: 'Manrope_700Bold', fontSize: 11 },
  permissionRowDescription: { color: COLORS.muted, fontFamily: 'Manrope_400Regular', fontSize: 8, lineHeight: 12, marginTop: 2 },
  permissionAction: { minWidth: 68, height: 44, borderRadius: 13, backgroundColor: COLORS.green, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 },
  permissionActionBusy: { opacity: 0.62 },
  permissionActionText: { color: COLORS.white, fontFamily: 'Manrope_700Bold', fontSize: 10 },
  operationBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.greenSoft, borderWidth: 1, borderColor: '#BED9C1', borderRadius: 20, padding: 13, marginTop: 10, marginBottom: 2 },
  operationBannerTerminal: { backgroundColor: COLORS.surface, borderColor: COLORS.line },
  operationPulse: { width: 39, height: 39, borderRadius: 13, backgroundColor: COLORS.lime, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  operationTerminalIcon: { backgroundColor: COLORS.orangeSoft },
  operationCopy: { flex: 1, minWidth: 0, paddingRight: 8 },
  operationEyebrow: { color: COLORS.orange, fontFamily: 'Manrope_800ExtraBold', fontSize: 7, letterSpacing: 1 },
  operationTitle: { color: COLORS.ink, fontFamily: 'Manrope_800ExtraBold', fontSize: 13, marginTop: 2 },
  operationDescription: { color: COLORS.muted, fontFamily: 'Manrope_400Regular', fontSize: 9, lineHeight: 13, marginTop: 2 },
  operationProgress: { color: COLORS.green, fontFamily: 'Manrope_700Bold', fontSize: 8, marginTop: 4 },
  operationStop: { minWidth: 62, minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, backgroundColor: COLORS.orangeSoft, borderRadius: 13, paddingHorizontal: 9 },
  operationStopText: { color: COLORS.red, fontFamily: 'Manrope_700Bold', fontSize: 9 },
  operationDismiss: { width: 40, height: 40, borderRadius: 13, backgroundColor: COLORS.soft, alignItems: 'center', justifyContent: 'center' },
  recoveryBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF5F0', borderWidth: 1, borderColor: '#F1D1C5', borderRadius: 18, padding: 12, marginTop: 10, marginBottom: 2 },
  recoveryIcon: { width: 34, height: 34, borderRadius: 11, backgroundColor: COLORS.orangeSoft, alignItems: 'center', justifyContent: 'center', marginRight: 9 },
  recoveryCopy: { flex: 1, minWidth: 0, paddingRight: 8 },
  recoveryTitle: { color: COLORS.ink, fontFamily: 'Manrope_800ExtraBold', fontSize: 11 },
  recoveryText: { color: COLORS.muted, fontFamily: 'Manrope_400Regular', fontSize: 8, lineHeight: 12, marginTop: 2 },
  recoveryAction: { minWidth: 54, height: 38, borderRadius: 12, backgroundColor: COLORS.green, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 9 },
  recoveryActionText: { color: COLORS.white, fontFamily: 'Manrope_700Bold', fontSize: 9 },
  pageHeadingRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginTop: 18, marginBottom: 24 },
  pageHeadingCopy: { flex: 1, paddingRight: 12 },
  kicker: { color: COLORS.orange, fontFamily: 'Manrope_800ExtraBold', fontSize: 9, letterSpacing: 1.3, marginBottom: 7 },
  pageTitle: { color: COLORS.ink, fontFamily: 'Manrope_800ExtraBold', fontSize: 30, lineHeight: 35, letterSpacing: -1.1 },
  pageSubtitle: { color: COLORS.muted, fontFamily: 'Manrope_400Regular', fontSize: 12, lineHeight: 18, maxWidth: 310, marginTop: 7 },
  stepBadge: { minWidth: 43, height: 43, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.greenSoft },
  stepBadgeText: { color: COLORS.green, fontFamily: 'Manrope_800ExtraBold', fontSize: 16 },
  setupCard: { backgroundColor: COLORS.green, borderRadius: 27, padding: 20, marginBottom: 28, shadowColor: '#0C2A20', shadowOpacity: 0.14, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 5 },
  setupTopline: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  setupLabel: { color: '#AFC7BD', fontFamily: 'Manrope_700Bold', fontSize: 8, letterSpacing: 1.2 },
  readyPill: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#285748', borderRadius: 13, paddingHorizontal: 9, paddingVertical: 6 },
  readyDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: COLORS.lime, marginRight: 6 },
  readyDotOff: { backgroundColor: COLORS.orange },
  readyText: { color: '#DCEBE3', fontFamily: 'Manrope_700Bold', fontSize: 7, letterSpacing: 0.6 },
  codeInput: { color: COLORS.white, fontFamily: 'Manrope_800ExtraBold', fontSize: 38, letterSpacing: 1.3, paddingHorizontal: 0, paddingTop: 14, paddingBottom: 9 },
  setupDivider: { height: 1, backgroundColor: '#356052', marginBottom: 17 },
  simRow: { flexDirection: 'row', gap: 9, marginTop: 11 },
  simChoice: { flex: 1, minHeight: 65, flexDirection: 'row', alignItems: 'center', backgroundColor: '#234E40', borderWidth: 1, borderColor: '#356255', borderRadius: 17, paddingHorizontal: 10 },
  simChoiceSelected: { backgroundColor: COLORS.lime, borderColor: COLORS.lime },
  simIcon: { width: 29, height: 29, borderRadius: 10, backgroundColor: '#356255', alignItems: 'center', justifyContent: 'center', marginRight: 8 },
  simIconSelected: { backgroundColor: '#A9D99C' },
  simCopy: { flex: 1, minWidth: 0 },
  simSlot: { color: '#BDD1C8', fontFamily: 'Manrope_700Bold', fontSize: 8, letterSpacing: 0.7 },
  simCarrier: { color: COLORS.white, fontFamily: 'Manrope_700Bold', fontSize: 11, marginTop: 2 },
  simTextSelected: { color: COLORS.green },
  simLoading: { minHeight: 57, flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
  simLoadingText: { color: '#C7D9D1', fontFamily: 'Manrope_500Medium', fontSize: 11 },
  simErrorBox: { backgroundColor: '#67392F', borderRadius: 15, padding: 13, marginTop: 10 },
  simErrorText: { color: '#FFD8CC', fontFamily: 'Manrope_500Medium', fontSize: 11 },
  retryText: { color: COLORS.white, fontFamily: 'Manrope_700Bold', fontSize: 10, marginTop: 5 },
  sectionHeading: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 15 },
  sectionHeadingCopy: { flex: 1, minWidth: 0, paddingRight: 6 },
  sectionTitle: { color: COLORS.ink, fontFamily: 'Manrope_800ExtraBold', fontSize: 20, letterSpacing: -0.5 },
  sectionSubtitle: { color: COLORS.muted, fontFamily: 'Manrope_400Regular', fontSize: 10, marginTop: 3 },
  sectionHeadingActions: { alignItems: 'flex-end', gap: 7, marginLeft: 8 },
  sectionCount: { color: COLORS.green, fontFamily: 'Manrope_700Bold', fontSize: 10, backgroundColor: COLORS.greenSoft, borderRadius: 12, paddingHorizontal: 9, paddingVertical: 6 },
  clearPathButton: { minHeight: 31, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: COLORS.orangeSoft, borderRadius: 11, paddingHorizontal: 9 },
  clearPathText: { color: COLORS.red, fontFamily: 'Manrope_700Bold', fontSize: 8 },
  variableHint: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, backgroundColor: COLORS.greenSoft, borderRadius: 17, padding: 13, marginBottom: 14 },
  variableHintCopy: { flex: 1 },
  variableHintTitle: { color: COLORS.green, fontFamily: 'Manrope_800ExtraBold', fontSize: 10 },
  variableHintText: { color: COLORS.green, fontFamily: 'Manrope_400Regular', fontSize: 8, lineHeight: 12, marginTop: 2 },
  variableHintNames: { color: COLORS.orange, fontFamily: 'Manrope_800ExtraBold', fontSize: 7, letterSpacing: 0.5, marginTop: 7 },
  stepsList: { position: 'relative' },
  routeRail: { position: 'absolute', left: 19, top: 21, bottom: 21, width: 2, backgroundColor: '#D7DDD7' },
  stepRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  stepDot: { width: 40, height: 40, borderRadius: 14, backgroundColor: COLORS.green, alignItems: 'center', justifyContent: 'center', marginRight: 10, zIndex: 2 },
  stepDotCancel: { backgroundColor: COLORS.orange },
  stepDotText: { color: COLORS.white, fontFamily: 'Manrope_800ExtraBold', fontSize: 12 },
  stepField: { flex: 1, minHeight: 64, backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.line, borderRadius: 17, paddingHorizontal: 14, paddingVertical: 9 },
  stepFieldCancel: { backgroundColor: COLORS.orangeSoft, borderColor: '#F5CDBE' },
  stepFieldVariable: { backgroundColor: '#F0F8EF', borderColor: '#BFD9BF' },
  stepFieldTopline: { minHeight: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stepFieldLabel: { color: COLORS.muted, fontFamily: 'Manrope_700Bold', fontSize: 7, letterSpacing: 0.9 },
  variableButton: { height: 25, flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: COLORS.greenSoft, borderRadius: 8, paddingHorizontal: 7 },
  variableButtonText: { color: COLORS.green, fontFamily: 'Manrope_700Bold', fontSize: 7 },
  stepInput: { minHeight: 31, color: COLORS.ink, fontFamily: 'Manrope_700Bold', fontSize: 17, paddingHorizontal: 0, paddingVertical: 1 },
  stepInputCancel: { color: COLORS.red },
  removeButton: { width: 38, height: 48, marginLeft: 5, borderRadius: 14, backgroundColor: COLORS.soft, alignItems: 'center', justifyContent: 'center' },
  stepActions: { flexDirection: 'row', gap: 8, marginLeft: 50, marginTop: 1, marginBottom: 24 },
  addButton: { height: 39, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 11, borderRadius: 13, backgroundColor: COLORS.greenSoft },
  addText: { color: COLORS.green, fontFamily: 'Manrope_700Bold', fontSize: 10 },
  addCancelButton: { height: 39, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 11, borderRadius: 13, backgroundColor: COLORS.orangeSoft },
  addCancelText: { color: COLORS.red, fontFamily: 'Manrope_700Bold', fontSize: 10 },
  routeCard: { backgroundColor: COLORS.greenSoft, borderRadius: 19, padding: 16, marginBottom: 12 },
  routeCardTopline: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 },
  routeCardLabel: { color: COLORS.green, fontFamily: 'Manrope_800ExtraBold', fontSize: 8, letterSpacing: 1 },
  routeCode: { color: COLORS.ink, fontFamily: 'Manrope_800ExtraBold', fontSize: 18, lineHeight: 26 },
  saveCard: { backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.line, borderRadius: 20, padding: 13, marginBottom: 12 },
  fieldLabel: { color: COLORS.muted, fontFamily: 'Manrope_700Bold', fontSize: 8, letterSpacing: 0.9, marginLeft: 3, marginBottom: 7 },
  saveRow: { flexDirection: 'row', gap: 8 },
  flowNameInput: { flex: 1, height: 49, color: COLORS.ink, backgroundColor: COLORS.paper, borderRadius: 14, paddingHorizontal: 13, fontFamily: 'Manrope_600SemiBold', fontSize: 12 },
  saveButton: { height: 49, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: COLORS.green, borderRadius: 14, paddingHorizontal: 15 },
  saveButtonText: { color: COLORS.white, fontFamily: 'Manrope_700Bold', fontSize: 11 },
  actionGrid: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  recordAction: { flex: 1, minHeight: 133, backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.line, borderRadius: 21, padding: 14 },
  recordActionActive: { backgroundColor: '#FFF1EB', borderColor: '#F1BBA7' },
  actionIconCircle: { width: 38, height: 38, borderRadius: 14, backgroundColor: COLORS.orangeSoft, alignItems: 'center', justifyContent: 'center', marginBottom: 11 },
  recordActionTitle: { color: COLORS.ink, fontFamily: 'Manrope_800ExtraBold', fontSize: 13 },
  recordActionCopy: { color: COLORS.muted, fontFamily: 'Manrope_400Regular', fontSize: 9, lineHeight: 14, marginTop: 4 },
  playAction: { flex: 1, minHeight: 133, backgroundColor: COLORS.green, borderRadius: 21, padding: 14 },
  playIconCircle: { width: 38, height: 38, borderRadius: 14, backgroundColor: COLORS.lime, alignItems: 'center', justifyContent: 'center', marginBottom: 11 },
  playActionTitle: { color: COLORS.white, fontFamily: 'Manrope_800ExtraBold', fontSize: 13 },
  playActionCopy: { color: '#BBD0C7', fontFamily: 'Manrope_400Regular', fontSize: 9, lineHeight: 14, marginTop: 4 },
  stopButton: { height: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderRadius: 15, backgroundColor: COLORS.orangeSoft, marginBottom: 10 },
  stopButtonText: { color: COLORS.red, fontFamily: 'Manrope_700Bold', fontSize: 11 },
  utilityRow: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  utilityButton: { flex: 1, minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1, borderColor: COLORS.line, borderRadius: 15, backgroundColor: COLORS.surface },
  utilityDisabled: { opacity: 0.43 },
  utilityText: { color: COLORS.green, fontFamily: 'Manrope_600SemiBold', fontSize: 9 },
  inlineStatus: { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: COLORS.orangeSoft, borderRadius: 14, padding: 11, marginBottom: 10 },
  inlineStatusText: { flex: 1, color: COLORS.red, fontFamily: 'Manrope_500Medium', fontSize: 9, lineHeight: 13 },
  responsePanel: { backgroundColor: COLORS.green, borderRadius: 21, padding: 17, marginTop: 5, marginBottom: 10 },
  responseHeader: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 9 },
  responseKicker: { color: COLORS.lime, fontFamily: 'Manrope_800ExtraBold', fontSize: 8, letterSpacing: 1 },
  responseText: { color: COLORS.white, fontFamily: 'Manrope_400Regular', fontSize: 13, lineHeight: 20 },
  errorText: { color: '#FFD3C4' },
  nextReplyRow: { borderTopWidth: 1, borderTopColor: '#3D6658', marginTop: 15, paddingTop: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  nextLabel: { color: '#AFC7BD', fontFamily: 'Manrope_700Bold', fontSize: 7, letterSpacing: 0.9 },
  nextValue: { color: COLORS.white, fontFamily: 'Manrope_800ExtraBold', fontSize: 22, marginTop: 2 },
  doneButton: { backgroundColor: COLORS.lime, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  doneButtonText: { color: COLORS.green, fontFamily: 'Manrope_700Bold', fontSize: 9 },
  privacyNote: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, backgroundColor: COLORS.soft, borderRadius: 16, padding: 13, marginTop: 3 },
  privacyText: { flex: 1, color: COLORS.muted, fontFamily: 'Manrope_400Regular', fontSize: 9, lineHeight: 14 },
  emptyState: { alignItems: 'center', backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.line, borderRadius: 24, padding: 28 },
  emptyIcon: { width: 52, height: 52, borderRadius: 18, backgroundColor: COLORS.greenSoft, alignItems: 'center', justifyContent: 'center', marginBottom: 15 },
  emptyTitle: { color: COLORS.ink, fontFamily: 'Manrope_800ExtraBold', fontSize: 18 },
  emptyCopy: { color: COLORS.muted, fontFamily: 'Manrope_400Regular', textAlign: 'center', fontSize: 11, lineHeight: 17, maxWidth: 260, marginTop: 7 },
  emptyButton: { height: 44, flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: COLORS.green, borderRadius: 14, paddingHorizontal: 16, marginTop: 18 },
  emptyButtonText: { color: COLORS.white, fontFamily: 'Manrope_700Bold', fontSize: 10 },
  queueHeadingActions: { alignItems: 'center', gap: 7 },
  queueRefreshButton: { width: 38, height: 38, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.greenSoft },
  queuePrivacyNote: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, backgroundColor: COLORS.greenSoft, borderRadius: 17, padding: 13, marginBottom: 14 },
  queuePrivacyText: { flex: 1, color: COLORS.green, fontFamily: 'Manrope_400Regular', fontSize: 9, lineHeight: 14 },
  queueErrorIcon: { backgroundColor: COLORS.orangeSoft },
  queueErrorBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#FFF5F0', borderWidth: 1, borderColor: '#F1D1C5', borderRadius: 15, padding: 11, marginBottom: 10 },
  queueErrorText: { flex: 1, color: COLORS.red, fontFamily: 'Manrope_500Medium', fontSize: 8, lineHeight: 12 },
  queueRetryText: { color: COLORS.green, fontFamily: 'Manrope_800ExtraBold', fontSize: 8 },
  queueJobCard: { backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.line, borderRadius: 21, padding: 15, marginBottom: 11 },
  queueJobTopline: { flexDirection: 'row', alignItems: 'center' },
  queueJobIcon: { width: 40, height: 40, borderRadius: 14, backgroundColor: COLORS.soft, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  queueJobIconQueued: { backgroundColor: COLORS.greenSoft },
  queueJobHeading: { flex: 1, minWidth: 0, paddingRight: 7 },
  queueJobName: { color: COLORS.ink, fontFamily: 'Manrope_800ExtraBold', fontSize: 14 },
  queueJobId: { color: COLORS.muted, fontFamily: 'Manrope_600SemiBold', fontSize: 7, letterSpacing: 0.35, marginTop: 4 },
  queueStatusPill: { maxWidth: 96, backgroundColor: COLORS.lime, borderRadius: 9, paddingHorizontal: 7, paddingVertical: 5 },
  queueStatusPillLocked: { backgroundColor: COLORS.soft },
  queueStatusText: { color: COLORS.green, fontFamily: 'Manrope_800ExtraBold', fontSize: 6.5, letterSpacing: 0.3, textAlign: 'center' },
  queueStatusTextLocked: { color: COLORS.muted },
  queueJobMeta: { flexDirection: 'row', backgroundColor: COLORS.paper, borderRadius: 13, padding: 11, marginTop: 12 },
  queueMetaColumn: { flex: 1, minWidth: 0 },
  queueMetaColumnRight: { alignItems: 'flex-end', borderLeftWidth: 1, borderLeftColor: COLORS.line, paddingLeft: 10 },
  queueMetaLabel: { color: COLORS.muted, fontFamily: 'Manrope_800ExtraBold', fontSize: 7, letterSpacing: 0.8 },
  queueMetaValue: { color: COLORS.ink, fontFamily: 'Manrope_600SemiBold', fontSize: 8, marginTop: 4 },
  queueDeleteButton: { height: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: COLORS.orangeSoft, borderRadius: 13, marginTop: 11 },
  queueDeleteText: { color: COLORS.red, fontFamily: 'Manrope_700Bold', fontSize: 9 },
  queueReadOnlyNote: { minHeight: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: COLORS.soft, borderRadius: 13, paddingHorizontal: 10, marginTop: 11 },
  queueReadOnlyText: { flex: 1, color: COLORS.muted, fontFamily: 'Manrope_500Medium', fontSize: 8, lineHeight: 12 },
  savedFlow: { backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.line, borderRadius: 22, padding: 16, marginBottom: 12 },
  savedTopline: { flexDirection: 'row', alignItems: 'center' },
  savedIndex: { width: 39, height: 39, borderRadius: 14, backgroundColor: COLORS.green, alignItems: 'center', justifyContent: 'center', marginRight: 11 },
  savedIndexText: { color: COLORS.lime, fontFamily: 'Manrope_800ExtraBold', fontSize: 9 },
  savedHeading: { flex: 1, minWidth: 0 },
  savedName: { color: COLORS.ink, fontFamily: 'Manrope_800ExtraBold', fontSize: 16 },
  savedMeta: { color: COLORS.muted, fontFamily: 'Manrope_500Medium', fontSize: 8, marginTop: 3 },
  iconButton: { width: 36, height: 36, borderRadius: 12, backgroundColor: COLORS.orangeSoft, alignItems: 'center', justifyContent: 'center' },
  savedRouteBox: { backgroundColor: COLORS.paper, borderRadius: 14, padding: 12, marginTop: 13 },
  savedRoute: { color: COLORS.green, fontFamily: 'Manrope_700Bold', fontSize: 12, lineHeight: 18 },
  savedVariables: { color: COLORS.orange, fontFamily: 'Manrope_800ExtraBold', fontSize: 7, letterSpacing: 0.5, marginTop: 8 },
  savedActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 12 },
  editButton: { height: 41, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 13, borderWidth: 1, borderColor: COLORS.line, borderRadius: 13 },
  editText: { color: COLORS.green, fontFamily: 'Manrope_700Bold', fontSize: 10 },
  playButton: { height: 41, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: COLORS.lime, borderRadius: 13, paddingHorizontal: 14 },
  playButtonText: { color: COLORS.green, fontFamily: 'Manrope_800ExtraBold', fontSize: 10 },
  clearButton: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: COLORS.orangeSoft, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 8 },
  clearText: { color: COLORS.red, fontFamily: 'Manrope_700Bold', fontSize: 9 },
  historyTable: { backgroundColor: COLORS.surface, borderRadius: 20, borderWidth: 1, borderColor: COLORS.line, overflow: 'hidden' },
  tableHeader: { minHeight: 39, flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.soft, paddingHorizontal: 12 },
  tableHeaderText: { color: COLORS.muted, fontFamily: 'Manrope_800ExtraBold', fontSize: 7, letterSpacing: 0.8 },
  flowColumn: { flex: 1, minWidth: 0 },
  dateColumn: { width: 68, paddingLeft: 7 },
  statusColumn: { width: 76, alignItems: 'flex-start' },
  chevronColumn: { width: 22, alignItems: 'flex-end' },
  historyRowGroup: { borderTopWidth: 1, borderTopColor: COLORS.line },
  historyRowGroupExpanded: { backgroundColor: '#FAFCF9' },
  tableRow: { minHeight: 72, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 11 },
  tableRowPressed: { backgroundColor: '#F0F4F0' },
  tableFlow: { color: COLORS.ink, fontFamily: 'Manrope_700Bold', fontSize: 11 },
  tableCode: { color: COLORS.muted, fontFamily: 'Manrope_500Medium', fontSize: 8, marginTop: 3 },
  tableDate: { color: COLORS.ink, fontFamily: 'Manrope_700Bold', fontSize: 9 },
  tableTime: { color: COLORS.muted, fontFamily: 'Manrope_400Regular', fontSize: 8, marginTop: 2 },
  statusPill: { minWidth: 64, alignItems: 'center', borderRadius: 9, backgroundColor: COLORS.greenSoft, paddingHorizontal: 6, paddingVertical: 5 },
  statusPillCancelled: { backgroundColor: COLORS.orangeSoft },
  statusPillStopped: { backgroundColor: '#EEEAE1' },
  statusPillText: { color: COLORS.green, fontFamily: 'Manrope_800ExtraBold', fontSize: 6.5, letterSpacing: 0.2, textAlign: 'center' },
  statusPillTextCancelled: { color: COLORS.red },
  statusPillTextStopped: { color: '#776C59' },
  accordionBody: { borderTopWidth: 1, borderTopColor: COLORS.line, paddingHorizontal: 12, paddingTop: 14, paddingBottom: 15 },
  sessionMetaRow: { flexDirection: 'row', justifyContent: 'space-between', backgroundColor: COLORS.soft, borderRadius: 13, padding: 12, marginBottom: 14 },
  sessionMetaRight: { alignItems: 'flex-end' },
  sessionMetaLabel: { color: COLORS.muted, fontFamily: 'Manrope_800ExtraBold', fontSize: 7, letterSpacing: 0.8, marginBottom: 4 },
  sessionMetaValue: { color: COLORS.ink, fontFamily: 'Manrope_700Bold', fontSize: 9 },
  detailHeading: { color: COLORS.muted, fontFamily: 'Manrope_800ExtraBold', fontSize: 7, letterSpacing: 1, marginBottom: 8 },
  sessionTimeline: { backgroundColor: COLORS.paper, borderRadius: 14, paddingHorizontal: 11, paddingVertical: 4 },
  sessionEntry: { flexDirection: 'row', paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  timelineMarker: { width: 25, height: 25, borderRadius: 9, backgroundColor: COLORS.green, alignItems: 'center', justifyContent: 'center', marginRight: 11 },
  timelineMarkerText: { color: COLORS.lime, fontFamily: 'Manrope_800ExtraBold', fontSize: 8 },
  timelineBody: { flex: 1 },
  historyResponse: { color: COLORS.ink, fontFamily: 'Manrope_400Regular', fontSize: 11, lineHeight: 17 },
  historyAction: { color: COLORS.orange, fontFamily: 'Manrope_800ExtraBold', fontSize: 7, letterSpacing: 0.6, marginTop: 7 },
  noDetailText: { color: COLORS.muted, fontFamily: 'Manrope_400Regular', fontSize: 10, lineHeight: 16, paddingVertical: 12 },
  bottomNav: { position: 'absolute', left: 18, right: 18, bottom: 13, height: 68, flexDirection: 'row', alignItems: 'center', backgroundColor: '#121A16', borderRadius: 23, paddingHorizontal: 7, paddingVertical: 7, shadowColor: '#09110D', shadowOpacity: 0.2, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 10 },
  navItem: { flex: 1, height: 54, borderRadius: 17, alignItems: 'center', justifyContent: 'center', gap: 2 },
  navItemActive: { backgroundColor: COLORS.lime },
  navIconWrap: { position: 'relative' },
  navQueueBadge: { position: 'absolute', right: -10, top: -6, minWidth: 17, height: 17, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.orange, borderWidth: 2, borderColor: '#121A16', paddingHorizontal: 3 },
  navQueueBadgeText: { color: COLORS.white, fontFamily: 'Manrope_800ExtraBold', fontSize: 6 },
  navLabel: { color: '#99A49E', fontFamily: 'Manrope_600SemiBold', fontSize: 8 },
  navLabelActive: { color: COLORS.green, fontFamily: 'Manrope_800ExtraBold' },
  primaryPressed: { transform: [{ scale: 0.985 }], opacity: 0.88 },
  pressed: { opacity: 0.62 },
  disabled: { opacity: 0.42 },
});
