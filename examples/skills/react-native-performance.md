---
name: react-native-performance
description: React Native runtime performance — virtualized lists (FlatList/FlashList), memoization with intent, avoiding re-renders from inline objects and closures, moving heavy work off the JS thread, and cancelling requests and listeners on unmount. Use for janky scrolling and large lists.
scope: mobile
---

# React Native Performance Playbook

**Measure first.** Use the React DevTools Profiler (in React Native DevTools), the
in-app Perf Monitor and a release build on a real low-end device before optimizing
anything. Apply these patterns where the plan marks a
`hot-path` or where profiling shows a real bottleneck.

---

## 1. Virtualized lists — FlatList and FlashList

For long or dynamic lists, always use a virtualized component. Plain `ScrollView`
renders all items at once and will OOM or jank on large datasets.

**`FlatList` — built-in, zero deps:**
```tsx
<FlatList
  data={items}
  keyExtractor={(item) => item.id}          // stable, unique key
  renderItem={({ item }) => <ItemRow item={item} />}
  getItemLayout={(_, index) => ({           // fixed height — skips measurement
    length: ITEM_HEIGHT,
    offset: ITEM_HEIGHT * index,
    index,
  })}
  windowSize={5}                            // 5 viewport heights total: ~2 above + visible + ~2 below
  initialNumToRender={15}
  maxToRenderPerBatch={10}
  removeClippedSubviews={true}
/>
```

**`@shopify/flash-list` — better recycling, drop-in replacement:**
```tsx
import { FlashList } from '@shopify/flash-list';

<FlashList
  data={items}
  keyExtractor={(item) => item.id}
  renderItem={({ item }) => <ItemRow item={item} />}
  estimatedItemSize={72}                    // FlashList v1: required (median height)
/>
```
FlashList v2 measures items itself and no longer needs `estimatedItemSize` — check
the version you have installed.

Prefer FlashList for lists over ~100 items or with complex cells.

---

## 2. Memoization with intent — don't add it everywhere

`React.memo`, `useMemo`, and `useCallback` add overhead (comparison cost + allocation).
Apply them only when profiling confirms a component re-renders unnecessarily on a
hot path.

**Good use — stable callback passed to a memoized child:**
```tsx
const handlePress = useCallback((id: string) => {
  navigation.navigate('Detail', { id });
}, [navigation]); // navigation is stable from useNavigation
```
```tsx
// at module level — never create a memoized component inside render
const ItemRow = React.memo(function ItemRow({ item, onPress }: ItemRowProps) {
  /* … */
});
```

**Bad use — memoizing a cheap primitive:**
```tsx
// not worth it — string concat is cheaper than the memo overhead
const label = useMemo(() => `${first} ${last}`, [first, last]);
```

---

## 3. Avoid re-renders from inline objects and closures

Inline object and function literals create a new reference on every render, breaking
shallow-equality checks in `React.memo` and `FlatList`.

**Bad:**
```tsx
// new object every render → FlatList re-renders all items
<FlatList contentContainerStyle={{ paddingBottom: 16 }} ... />

// new function every render → ItemRow re-renders even if memo'd
<FlatList renderItem={({ item }) => <ItemRow item={item} onPress={() => select(item.id)} />} />
```

**Good — stable references:**
```tsx
const CONTENT_STYLE = { paddingBottom: 16 } as const;

const renderItem = useCallback(
  ({ item }: { item: Item }) => <ItemRow item={item} onPress={handlePress} />,
  [handlePress],
);

<FlatList contentContainerStyle={CONTENT_STYLE} renderItem={renderItem} ... />
```

---

## 4. Move heavy work off the JS thread

The JS thread drives animations and touch responses. Blocking it causes dropped frames.

**Defer after interaction** (this still runs on the JS thread — it only waits until
animations finish; split long work into chunks):
```ts
import { InteractionManager } from 'react-native';

// Run after the current animation/transition finishes
InteractionManager.runAfterInteractions(() => {
  parseHeavyData(rawPayload);
});
```

**Worklets (Reanimated) — run on the UI thread:**
```ts
import { useAnimatedStyle, withSpring } from 'react-native-reanimated';

const style = useAnimatedStyle(() => ({
  transform: [{ translateY: withSpring(offset.value) }],
})); // runs on UI thread, never blocks JS
```

**Native module / JSI for CPU-heavy work** (image processing, crypto, parsing):
wrap in a native module or use a library that already does so. Don't block the JS
thread with a tight loop over large data.

---

## 5. Cancel requests and listeners on unmount

Forgetting to cancel creates memory leaks and state updates on unmounted components.

**AbortController for fetch:**
```tsx
useEffect(() => {
  const controller = new AbortController();

  fetch('/api/feed', { signal: controller.signal })
    .then((r) => r.json())
    .then(setItems)
    .catch((err) => { if (err.name !== 'AbortError') setError(err); });

  return () => controller.abort(); // called on unmount
}, []);
```

**Event listeners:**
```tsx
useEffect(() => {
  const sub = AppState.addEventListener('change', handleAppState);
  return () => sub.remove(); // cleanup
}, []);
```

**Subscriptions (e.g. Firestore, WebSocket):**
```tsx
useEffect(() => {
  const unsub = db.collection('messages').onSnapshot(setMessages);
  return unsub; // Firestore returns the unsubscribe fn directly
}, []);
```

---

## Restraint rule

Don't memoize, virtualize, or offload work preemptively. Measure with the profiler,
identify the actual bottleneck, then apply the minimal fix.
