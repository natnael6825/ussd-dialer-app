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

import UssdDialer from './modules/ussd-dialer';

type RunState = 'idle' | 'dialing' | 'answered' | 'failed';
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
type AppView = 'build' | 'saved' | 'history';
type RecordingResult = {
  status: string;
  code: string;
  subscriptionId: number;
  replies: string[];
  updatedAt: number;
};

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
  const [response, setResponse] = useState('');
  const [error, setError] = useState('');
  const [nextIndex, setNextIndex] = useState(0);
  const [simOptions, setSimOptions] = useState<SimOption[]>([]);
  const [selectedSimId, setSelectedSimId] = useState<number | null>(null);
  const [simError, setSimError] = useState('');
  const [loadingSims, setLoadingSims] = useState(true);
  const [accessibilityEnabled, setAccessibilityEnabled] = useState(false);
  const [activeView, setActiveView] = useState<AppView>('build');
  const [flowName, setFlowName] = useState('');
  const [savedFlows, setSavedFlows] = useState<SavedFlow[]>([]);
  const [history, setHistory] = useState<HistorySession[]>([]);
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const responseOpacity = useRef(new Animated.Value(0)).current;
  const handledRecordingAt = useRef(0);

  const routeSummary = useMemo(
    () => [normalizeCode(code), ...steps.map((step) => step.trim()).filter(Boolean)].join('  →  '),
    [code, steps],
  );
  const valid = selectedSimId !== null && normalizeCode(code).length >= 3 && steps.some((step) => step.trim());

  useEffect(() => {
    loadSimOptions();
    refreshAccessibilityStatus();
    loadLibrary();
    syncRecording();
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        refreshAccessibilityStatus();
        loadLibrary();
        syncRecording();
      }
    });
    return () => subscription.remove();
  }, []);

  async function refreshAccessibilityStatus() {
    try {
      setAccessibilityEnabled(await UssdDialer.isAccessibilityEnabled());
    } catch {
      setAccessibilityEnabled(false);
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
    } catch {
      // The library remains usable after the native module finishes loading.
    }
  }

  async function syncRecording() {
    try {
      const recording = await UssdDialer.getRecording();
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
        recording.updatedAt > handledRecordingAt.current
      ) {
        handledRecordingAt.current = recording.updatedAt;
        applyRecording(recording);
        await UssdDialer.acknowledgeRecording(recording.updatedAt);
      }
    } catch {
      setIsRecording(false);
    }
  }

  function applyRecording(recording: RecordingResult, showNotice = true) {
    if (recording.code) setCode(recording.code);
    if (recording.subscriptionId >= 0) setSelectedSimId(recording.subscriptionId);
    if (recording.replies.length) setSteps(recording.replies);
    if (!showNotice) return;
    const count = recording.replies.length;
    Alert.alert(
      count ? 'Flow recorded' : 'Nothing recorded',
      count
        ? `${count} ${count === 1 ? 'reply was' : 'replies were'} captured. Review the steps, enter a flow name, then save it.`
        : 'No menu replies were captured. Try recording again and press Send after each reply.',
    );
  }

  async function loadSimOptions() {
    if (Platform.OS !== 'android') return;
    setLoadingSims(true);
    setSimError('');
    try {
      const permission = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE, {
        title: 'Choose a SIM',
        message: 'USSD Flow needs phone access to show the active SIM cards before dialing.',
        buttonPositive: 'Show SIMs',
        buttonNegative: 'Not now',
      });
      if (permission !== PermissionsAndroid.RESULTS.GRANTED) {
        setSimError('Allow phone access to choose a SIM.');
        return;
      }
      const subscriptions = await UssdDialer.getSubscriptions();
      setSimOptions(subscriptions);
      setSelectedSimId(subscriptions.length === 1 ? subscriptions[0].id : null);
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

  function addStep() {
    setSteps((current) => [...current, '']);
  }

  function addCancelStep() {
    setSteps((current) => [...current, 'CANCEL']);
  }

  function removeStep(index: number) {
    setSteps((current) => current.filter((_, i) => i !== index));
  }

  async function ensurePhonePermission() {
    if (Platform.OS !== 'android') return false;
    const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CALL_PHONE, {
      title: 'Allow USSD requests',
      message: 'USSD Flow needs phone access to send the code and receive the carrier response.',
      buttonPositive: 'Allow',
      buttonNegative: 'Not now',
    });
    return result === PermissionsAndroid.RESULTS.GRANTED;
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
    const allowed = await ensurePhonePermission();
    if (!allowed) return;

    setState('dialing');
    setResponse('');
    setError('');
    responseOpacity.setValue(0);
    if (guided) setNextIndex(0);

    try {
      const carrierResponse = await UssdDialer.send(normalizeCode(request), selectedSimId);
      setResponse(carrierResponse);
      setState('answered');
      Animated.timing(responseOpacity, {
        toValue: 1,
        duration: 360,
        useNativeDriver: true,
      }).start();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'The carrier did not return a response.';
      setError(message);
      setState('failed');
      Animated.timing(responseOpacity, {
        toValue: 1,
        duration: 240,
        useNativeDriver: true,
      }).start();
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
    await UssdDialer.openAccessibilitySettings();
  }

  async function startStepByStep(flow?: Pick<SavedFlow, 'name' | 'code' | 'replies' | 'subscriptionId'>) {
    const runCode = flow?.code ?? code;
    const runSteps = flow?.replies ?? steps;
    const runSimId = flow?.subscriptionId ?? selectedSimId;
    const runName = flow?.name ?? (flowName.trim() || 'Unsaved flow');
    if (runSimId === null) {
      Alert.alert('Choose a SIM', 'Select the SIM card to use before starting.');
      return;
    }
    if (!simOptions.some((sim) => sim.id === runSimId)) {
      Alert.alert('Saved SIM unavailable', 'This flow was saved for a SIM that is not currently active. Edit it and choose an available SIM.');
      return;
    }
    const cleanSteps = runSteps.map((step) => step.trim()).filter(Boolean);
    if (!accessibilityEnabled) {
      Alert.alert(
        'Enable automation',
        'Open Accessibility settings, choose USSD Flow automation, and turn it on. The service acts only after you start a route.',
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'Open settings', onPress: openAccessibilitySetup },
        ],
      );
      return;
    }
    if (!(await ensurePhonePermission())) return;
    try {
      setState('dialing');
      setResponse('');
      setError('');
      await UssdDialer.startAutomation(normalizeCode(runCode), cleanSteps, runSimId, runName);
    } catch (caught) {
      setState('failed');
      setError(caught instanceof Error ? caught.message : 'Could not start step-by-step dialing.');
      responseOpacity.setValue(1);
    }
  }

  async function startFlowRecording() {
    if (selectedSimId === null) {
      Alert.alert('Choose a SIM', 'Select the SIM card to use before recording.');
      return;
    }
    if (!accessibilityEnabled) {
      Alert.alert('Enable automation', 'Accessibility must be enabled to record the replies you enter.', [
        { text: 'Not now', style: 'cancel' },
        { text: 'Open settings', onPress: openAccessibilitySetup },
      ]);
      return;
    }
    if (!(await ensurePhonePermission())) return;
    try {
      handledRecordingAt.current = Date.now();
      setIsRecording(true);
      await UssdDialer.startRecording(normalizeCode(code), selectedSimId);
    } catch (caught) {
      setIsRecording(false);
      Alert.alert('Recording failed', caught instanceof Error ? caught.message : 'Could not start the USSD recorder.');
    }
  }

  async function stopFlowRecording() {
    const recording = await UssdDialer.finishRecording();
    setIsRecording(false);
    handledRecordingAt.current = recording.updatedAt;
    applyRecording(recording);
    await UssdDialer.acknowledgeRecording(recording.updatedAt);
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
    await UssdDialer.saveFlow(flowName.trim(), normalizeCode(code), steps, selectedSimId);
    await UssdDialer.clearPendingRecording();
    await loadLibrary();
    setActiveView('saved');
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
          await UssdDialer.deleteFlow(flow.id);
          await loadLibrary();
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
          await UssdDialer.clearResponseHistory();
          setHistory([]);
        },
      },
    ]);
  }

  async function cancelStepByStep() {
    await UssdDialer.cancelAutomation();
    setState('idle');
  }

  const nextReply = steps[nextIndex]?.trim();

  if (!fontsLoaded) {
    return (
      <View style={styles.loadingScreen}>
        <Image source={require('./assets/ussd-flow-logo.png')} style={styles.loadingLogo} />
        <ActivityIndicator color={COLORS.green} />
      </View>
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
              <Pressable onPress={openAccessibilitySetup} style={({ pressed }) => [styles.settingsButton, pressed && styles.pressed]}>
                <View style={[styles.statusDot, accessibilityEnabled && styles.statusDotReady]} />
                <Ionicons name="settings-outline" size={20} color={COLORS.ink} />
              </Pressable>
            </View>

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
                      <View style={[styles.readyDot, !accessibilityEnabled && styles.readyDotOff]} />
                      <Text style={styles.readyText}>{accessibilityEnabled ? 'READY' : 'SETUP NEEDED'}</Text>
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
                    <Pressable onPress={loadSimOptions} style={styles.simErrorBox}>
                      <Text style={styles.simErrorText}>{simError || 'No active SIM card found.'}</Text>
                      <Text style={styles.retryText}>Try again</Text>
                    </Pressable>
                  )}
                </View>

                <View style={styles.sectionHeading}>
                  <View>
                    <Text style={styles.sectionTitle}>Menu path</Text>
                    <Text style={styles.sectionSubtitle}>One reply is sent after each carrier response.</Text>
                  </View>
                  <Text style={styles.sectionCount}>{steps.length} {steps.length === 1 ? 'step' : 'steps'}</Text>
                </View>

                <View style={styles.stepsList}>
                  <View style={styles.routeRail} />
                  {steps.map((step, index) => {
                    const isCancel = step.trim().toUpperCase() === 'CANCEL';
                    return (
                      <View key={index} style={styles.stepRow}>
                        <View style={[styles.stepDot, isCancel && styles.stepDotCancel]}>
                          <Text style={styles.stepDotText}>{index + 1}</Text>
                        </View>
                        <View style={[styles.stepField, isCancel && styles.stepFieldCancel]}>
                          <Text style={styles.stepFieldLabel}>{isCancel ? 'END SESSION' : `REPLY ${index + 1}`}</Text>
                          <TextInput
                            accessibilityLabel={`Reply ${index + 1}`}
                            keyboardType="phone-pad"
                            maxLength={40}
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
                    <Pressable onPress={saveCurrentFlow} style={({ pressed }) => [styles.saveButton, pressed && styles.pressed]}>
                      <Ionicons name="bookmark-outline" size={17} color={COLORS.white} />
                      <Text style={styles.saveButtonText}>Save</Text>
                    </Pressable>
                  </View>
                </View>

                <View style={styles.actionGrid}>
                  <Pressable
                    disabled={!normalizeCode(code) || selectedSimId === null}
                    onPress={isRecording ? stopFlowRecording : startFlowRecording}
                    style={({ pressed }) => [styles.recordAction, isRecording && styles.recordActionActive, (!normalizeCode(code) || selectedSimId === null) && styles.disabled, pressed && styles.primaryPressed]}
                  >
                    <View style={styles.actionIconCircle}><Ionicons name={isRecording ? 'stop' : 'radio'} size={20} color={COLORS.orange} /></View>
                    <Text style={styles.recordActionTitle}>{isRecording ? 'Stop recording' : 'Record manually'}</Text>
                    <Text style={styles.recordActionCopy}>{isRecording ? 'Return here after the USSD session.' : 'Capture the replies you enter.'}</Text>
                  </Pressable>
                  <Pressable
                    disabled={!valid || !accessibilityEnabled || state === 'dialing' || isRecording}
                    onPress={() => startStepByStep()}
                    style={({ pressed }) => [styles.playAction, (!valid || !accessibilityEnabled || state === 'dialing' || isRecording) && styles.disabled, pressed && styles.primaryPressed]}
                  >
                    <View style={styles.playIconCircle}><Ionicons name="play" size={19} color={COLORS.green} /></View>
                    <Text style={styles.playActionTitle}>{state === 'dialing' ? 'Flow running' : 'Play this flow'}</Text>
                    <Text style={styles.playActionCopy}>Dial and reply automatically.</Text>
                  </Pressable>
                </View>

                {state === 'dialing' && (
                  <Pressable onPress={cancelStepByStep} style={({ pressed }) => [styles.stopButton, pressed && styles.pressed]}>
                    <Ionicons name="stop-circle-outline" size={18} color={COLORS.red} />
                    <Text style={styles.stopButtonText}>Stop active automation</Text>
                  </Pressable>
                )}

                <View style={styles.utilityRow}>
                  <Pressable disabled={!valid || state === 'dialing' || Number(Platform.Version) < 26} onPress={() => dial(code, true)} style={({ pressed }) => [styles.utilityButton, (Number(Platform.Version) < 26 || !valid) && styles.utilityDisabled, pressed && styles.pressed]}>
                    <Ionicons name="chatbubble-ellipses-outline" size={17} color={COLORS.green} />
                    <Text style={styles.utilityText}>{Number(Platform.Version) < 26 ? 'Test needs Android 8' : 'Test starting code'}</Text>
                  </Pressable>
                  <Pressable disabled={!normalizeCode(code)} onPress={openPhoneDialer} style={({ pressed }) => [styles.utilityButton, pressed && styles.pressed]}>
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
                  <Text style={styles.privacyText}>Flow data stays on this phone. Accessibility acts only after you start a flow or recording.</Text>
                </View>
              </View>
            )}

            {activeView === 'saved' && (
              <View>
                <View style={styles.pageHeadingRow}>
                  <View style={styles.pageHeadingCopy}><Text style={styles.kicker}>YOUR LIBRARY</Text><Text style={styles.pageTitle}>Saved flows.</Text><Text style={styles.pageSubtitle}>Run a familiar USSD route without remembering each menu.</Text></View>
                  <View style={styles.stepBadge}><Text style={styles.stepBadgeText}>{savedFlows.length}</Text></View>
                </View>
                {!savedFlows.length ? (
                  <View style={styles.emptyState}>
                    <View style={styles.emptyIcon}><Ionicons name="bookmark-outline" size={25} color={COLORS.green} /></View>
                    <Text style={styles.emptyTitle}>No saved flows yet</Text>
                    <Text style={styles.emptyCopy}>Create a route, give it a name, and it will be ready here.</Text>
                    <Pressable onPress={() => setActiveView('build')} style={styles.emptyButton}><Text style={styles.emptyButtonText}>Create first flow</Text><Ionicons name="arrow-forward" size={16} color={COLORS.white} /></Pressable>
                  </View>
                ) : savedFlows.map((flow, index) => {
                  const sim = simOptions.find((option) => option.id === flow.subscriptionId);
                  return (
                    <View key={flow.id} style={styles.savedFlow}>
                      <View style={styles.savedTopline}>
                        <View style={styles.savedIndex}><Text style={styles.savedIndexText}>{String(index + 1).padStart(2, '0')}</Text></View>
                        <View style={styles.savedHeading}><Text style={styles.savedName}>{flow.name}</Text><Text style={styles.savedMeta}>{sim ? `SIM ${sim.slotIndex + 1}  ·  ${sim.carrierName}` : 'Saved SIM unavailable'}</Text></View>
                        <Pressable onPress={() => deleteSavedFlow(flow)} hitSlop={8} style={styles.iconButton}><Ionicons name="trash-outline" size={18} color={COLORS.red} /></Pressable>
                      </View>
                      <View style={styles.savedRouteBox}><Text numberOfLines={2} style={styles.savedRoute}>{[flow.code, ...flow.replies].join('  →  ')}</Text></View>
                      <View style={styles.savedActions}>
                        <Pressable onPress={() => editSavedFlow(flow)} style={styles.editButton}><Ionicons name="create-outline" size={17} color={COLORS.green} /><Text style={styles.editText}>Edit</Text></Pressable>
                        <Pressable onPress={() => startStepByStep(flow)} style={({ pressed }) => [styles.playButton, pressed && styles.primaryPressed]}><Ionicons name="play" size={16} color={COLORS.green} /><Text style={styles.playButtonText}>Play flow</Text></Pressable>
                      </View>
                    </View>
                  );
                })}
              </View>
            )}

            {activeView === 'history' && (
              <View>
                <View style={styles.pageHeadingRow}>
                  <View style={styles.pageHeadingCopy}><Text style={styles.kicker}>SESSION LOG</Text><Text style={styles.pageTitle}>History.</Text><Text style={styles.pageSubtitle}>Tap a session to inspect every captured response and reply.</Text></View>
                  {!!history.length && <Pressable onPress={clearHistory} style={styles.clearButton}><Ionicons name="trash-outline" size={16} color={COLORS.red} /><Text style={styles.clearText}>Clear</Text></Pressable>}
                </View>
                {!history.length ? (
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
                            <View style={styles.statusColumn}><View style={[styles.statusPill, session.status === 'cancelled' && styles.statusPillCancelled, (session.status === 'timed_out' || session.status === 'stopped') && styles.statusPillStopped]}><Text style={[styles.statusPillText, session.status === 'cancelled' && styles.statusPillTextCancelled, (session.status === 'timed_out' || session.status === 'stopped') && styles.statusPillTextStopped]}>{session.status === 'timed_out' ? 'TIMEOUT' : session.status.toUpperCase()}</Text></View></View>
                            <View style={styles.chevronColumn}><Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={17} color={COLORS.green} /></View>
                          </Pressable>
                          {expanded && (
                            <View style={styles.accordionBody}>
                              <View style={styles.sessionMetaRow}><View><Text style={styles.sessionMetaLabel}>SIM</Text><Text style={styles.sessionMetaValue}>{sim ? `SIM ${sim.slotIndex + 1} · ${sim.carrierName}` : 'Saved SIM'}</Text></View><View style={styles.sessionMetaRight}><Text style={styles.sessionMetaLabel}>DURATION</Text><Text style={styles.sessionMetaValue}>{session.endedAt > session.startedAt ? `${Math.max(1, Math.round((session.endedAt - session.startedAt) / 1000))} sec` : '—'}</Text></View></View>
                              <Text style={styles.detailHeading}>SESSION DETAILS</Text>
                              <View style={styles.sessionTimeline}>{session.entries.length ? session.entries.map((entry, index) => (
                                <View key={`${session.id}-${entry.timestamp}-${index}`} style={styles.sessionEntry}><View style={styles.timelineMarker}><Text style={styles.timelineMarkerText}>{index + 1}</Text></View><View style={styles.timelineBody}><Text selectable style={styles.historyResponse}>{entry.response}</Text><Text style={styles.historyAction}>{entry.action === 'cancel' ? 'CANCELLED AFTER RESPONSE' : `REPLIED ${entry.reply}`}</Text></View></View>
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
              { view: 'history' as AppView, label: 'History', icon: 'time-outline' as const, activeIcon: 'time' as const },
            ]).map((item) => {
              const selected = activeView === item.view;
              return (
                <Pressable key={item.view} onPress={() => { setActiveView(item.view); if (item.view !== 'build') loadLibrary(); }} style={({ pressed }) => [styles.navItem, selected && styles.navItemActive, pressed && styles.pressed]}>
                  <Ionicons name={selected ? item.activeIcon : item.icon} size={21} color={selected ? COLORS.green : '#9AA79F'} />
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
  sectionTitle: { color: COLORS.ink, fontFamily: 'Manrope_800ExtraBold', fontSize: 20, letterSpacing: -0.5 },
  sectionSubtitle: { color: COLORS.muted, fontFamily: 'Manrope_400Regular', fontSize: 10, marginTop: 3 },
  sectionCount: { color: COLORS.green, fontFamily: 'Manrope_700Bold', fontSize: 10, backgroundColor: COLORS.greenSoft, borderRadius: 12, paddingHorizontal: 9, paddingVertical: 6 },
  stepsList: { position: 'relative' },
  routeRail: { position: 'absolute', left: 19, top: 21, bottom: 21, width: 2, backgroundColor: '#D7DDD7' },
  stepRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  stepDot: { width: 40, height: 40, borderRadius: 14, backgroundColor: COLORS.green, alignItems: 'center', justifyContent: 'center', marginRight: 10, zIndex: 2 },
  stepDotCancel: { backgroundColor: COLORS.orange },
  stepDotText: { color: COLORS.white, fontFamily: 'Manrope_800ExtraBold', fontSize: 12 },
  stepField: { flex: 1, minHeight: 64, backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.line, borderRadius: 17, paddingHorizontal: 14, paddingVertical: 9 },
  stepFieldCancel: { backgroundColor: COLORS.orangeSoft, borderColor: '#F5CDBE' },
  stepFieldLabel: { color: COLORS.muted, fontFamily: 'Manrope_700Bold', fontSize: 7, letterSpacing: 0.9 },
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
  navLabel: { color: '#99A49E', fontFamily: 'Manrope_600SemiBold', fontSize: 8 },
  navLabelActive: { color: COLORS.green, fontFamily: 'Manrope_800ExtraBold' },
  primaryPressed: { transform: [{ scale: 0.985 }], opacity: 0.88 },
  pressed: { opacity: 0.62 },
  disabled: { opacity: 0.42 },
});
