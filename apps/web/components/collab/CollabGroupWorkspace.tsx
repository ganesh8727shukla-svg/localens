"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { ArrowLeft, CalendarDays, Check, ChevronDown, Copy, MapPin, RefreshCw, UsersRound } from "lucide-react";
import { PageContainer } from "@/components/layout/PageContainer";
import { Card, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import { ApiError } from "@/lib/api/client";
import {
  addCollabWishlistItem,
  closeCollabDecision,
  createCollabDecision,
  finalizeCollabPlan,
  getCollabDecisions,
  getCollabGroup,
  getCollabPlan,
  getCollabPreferenceAnalysis,
  getCollabRecommendations,
  getCollabWishlist,
  removeCollabMember,
  removeCollabWishlistItem,
  reviewCollabPlan,
  reactToCollabWishlistItem,
  subscribeToCollabEvents,
  updateCollabGroup,
  updateCollabPlan,
  updateCollabPreferences,
  voteCollabDecision,
} from "@/lib/api/collab";
import { useAuth } from "@/lib/auth/AuthContext";
import type {
  CollabDecision,
  CollabGroup,
  CollabPlan,
  CollabProfilePayload,
  CollabRecommendation,
  CollabWishlistItem,
  PreferenceAnalysis,
} from "@/types/collab";

interface ProfileForm {
  interests: string;
  food_preferences: string;
  activities: string;
  dislikes: string;
  pace: "" | "relaxed" | "balanced" | "packed";
  crowd_preference: "" | "low" | "medium" | "high";
  walking_tolerance_km: string;
  age: string;
  budget_max: string;
  max_distance_km: string;
  accessibility_requirements: ("wheelchair_accessible" | "step_free")[];
}

const emptyProfile: ProfileForm = {
  interests: "", food_preferences: "", activities: "", dislikes: "", pace: "", crowd_preference: "",
  walking_tolerance_km: "", age: "", budget_max: "", max_distance_km: "", accessibility_requirements: [],
};
const splitList = (value: string) => value.split(",").map((part) => part.trim()).filter(Boolean);
const formatList = (value: unknown) => Array.isArray(value) ? value.map(String).join(", ") : "";
const safeList = (value: unknown) => Array.isArray(value) ? value.map(String) : [];
const toNumberOrNull = (value: string) => value.trim() === "" ? null : Number(value);
const errorMessage = (error: unknown) => error instanceof ApiError ? error.message : "Something went wrong. Please try again.";

function formFromMember(member: CollabGroup["members"][number]): ProfileForm {
  const soft = member.soft_preferences ?? {};
  const hard = member.hard_constraints ?? {};
  return {
    interests: formatList(soft.interests),
    food_preferences: formatList(soft.food_preferences),
    activities: formatList(soft.activities),
    dislikes: formatList(soft.dislikes),
    pace: (soft.pace as ProfileForm["pace"]) || "",
    crowd_preference: (soft.crowd_preference as ProfileForm["crowd_preference"]) || "",
    walking_tolerance_km: soft.walking_tolerance_km == null ? "" : String(soft.walking_tolerance_km),
    age: hard.age == null ? "" : String(hard.age),
    budget_max: hard.budget_max == null ? "" : String(hard.budget_max),
    max_distance_km: hard.max_distance_km == null ? "" : String(hard.max_distance_km),
    accessibility_requirements: safeList(hard.accessibility_requirements) as ProfileForm["accessibility_requirements"],
  };
}

function parseProfile(form: ProfileForm): CollabProfilePayload {
  return {
    interests: splitList(form.interests),
    food_preferences: splitList(form.food_preferences),
    activities: splitList(form.activities),
    dislikes: splitList(form.dislikes),
    pace: form.pace || null,
    crowd_preference: form.crowd_preference || null,
    walking_tolerance_km: toNumberOrNull(form.walking_tolerance_km),
    age: form.age.trim() ? Number(form.age) : null,
    budget_max: toNumberOrNull(form.budget_max),
    max_distance_km: toNumberOrNull(form.max_distance_km),
    accessibility_requirements: form.accessibility_requirements,
  };
}

function Section({ title, description, children, action }: { title: string; description?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1"><h2 className="text-xl font-semibold tracking-tight text-ink">{title}</h2>{description ? <p className="text-sm leading-6 text-ink-muted">{description}</p> : null}</div>
        {action}
      </div>
      {children}
    </section>
  );
}

function TagList({ values }: { values: string[] }) {
  return values.length ? <div className="flex flex-wrap gap-2">{values.map((value) => <Badge key={value} tone="neutral">{value}</Badge>)}</div> : <p className="text-sm text-ink-subtle">No preferences recorded.</p>;
}

export function CollabGroupWorkspace({ groupId }: { groupId: string }) {
  const { user, refreshSession } = useAuth();
  const [group, setGroup] = useState<CollabGroup | null>(null);
  const [analysis, setAnalysis] = useState<PreferenceAnalysis | null>(null);
  const [recommendations, setRecommendations] = useState<CollabRecommendation[]>([]);
  const [recommendationWarnings, setRecommendationWarnings] = useState<string[]>([]);
  const [wishlist, setWishlist] = useState<CollabWishlistItem[]>([]);
  const [decisions, setDecisions] = useState<CollabDecision[]>([]);
  const [plan, setPlan] = useState<CollabPlan | null>(null);
  const [profileForm, setProfileForm] = useState<ProfileForm>(emptyProfile);
  const profileDirty = useRef(false);
  const planDirty = useRef(false);
  const objectivesDirty = useRef(false);
  const [search, setSearch] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [objectiveInterests, setObjectiveInterests] = useState("");
  const [objectiveMustInclude, setObjectiveMustInclude] = useState("");
  const [decisionTitle, setDecisionTitle] = useState("");
  const [decisionOptionIds, setDecisionOptionIds] = useState<string[]>([]);
  const [planTitle, setPlanTitle] = useState("");
  const [planSelection, setPlanSelection] = useState<Record<string, boolean>>({});
  const [optionalSelection, setOptionalSelection] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [nextGroup, nextAnalysis, nextRecommendations, nextWishlist, nextDecisions, nextPlan] = await Promise.all([
        getCollabGroup(groupId, signal),
        getCollabPreferenceAnalysis(groupId, signal),
        getCollabRecommendations(groupId, activeQuery || undefined, signal),
        getCollabWishlist(groupId, signal),
        getCollabDecisions(groupId, signal),
        getCollabPlan(groupId, signal),
      ]);
      if (signal?.aborted) return;
      setError(null);
      setGroup(nextGroup);
      setAnalysis(nextAnalysis);
      setRecommendations(nextRecommendations.items);
      setRecommendationWarnings(nextRecommendations.warnings);
      setWishlist(nextWishlist);
      setDecisions(nextDecisions);
      setPlan(nextPlan);
      if (!profileDirty.current) {
        const mine = nextGroup.members.find((member) => member.id === nextGroup.my_member_id);
        if (mine) setProfileForm(formFromMember(mine));
      }
      if (!planDirty.current && nextPlan) {
        setPlanTitle(nextPlan.title);
        setPlanSelection(Object.fromEntries(nextPlan.items.map((item) => [item.experience_id, true])));
        setOptionalSelection(Object.fromEntries(nextPlan.items.map((item) => [item.experience_id, item.is_optional])));
      } else if (!planDirty.current && !nextPlan) {
        setPlanTitle(`${nextGroup.title} itinerary`);
        setPlanSelection({});
        setOptionalSelection({});
      }
      if (!objectivesDirty.current) {
        setObjectiveInterests(formatList(nextGroup.objectives.interests));
        setObjectiveMustInclude(formatList(nextGroup.objectives.must_include));
      }
      if (!signal?.aborted) setLoading(false);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (!signal?.aborted) {
        setError(errorMessage(err));
        setLoading(false);
      }
    }
  }, [activeQuery, groupId]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [load, refreshKey]);

  useEffect(() => {
    const controller = new AbortController();
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      try {
        await subscribeToCollabEvents(
          groupId,
          (eventType) => {
            if (eventType.startsWith("collab_")) setRefreshKey((current) => current + 1);
          },
          controller.signal,
          refreshSession,
        );
      } catch {
        if (controller.signal.aborted) return;
      }
      if (!controller.signal.aborted) reconnect = setTimeout(() => void connect(), 2500);
    };
    void connect();
    return () => {
      controller.abort();
      if (reconnect) clearTimeout(reconnect);
    };
  }, [groupId, refreshSession]);

  const me = group?.members.find((member) => member.id === group.my_member_id) ?? null;
  const isOwner = me?.role === "owner";
  const currentApproval = plan?.approvals.find((approval) => approval.member_id === group?.my_member_id);
  const allApproved = Boolean(plan && group && group.members.length > 0 && group.members.every((member) => plan.approvals.some((approval) => approval.member_id === member.id && approval.status === "APPROVED")));
  const myTripId = plan?.trips.find((trip) => trip.user_id === user?.id)?.itinerary_id;
  const selectedPlanCount = Object.values(planSelection).filter(Boolean).length;

  async function runAction(action: () => Promise<unknown>, successMessage?: string) {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await action();
      if (successMessage) setMessage(successMessage);
      setRefreshKey((current) => current + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await updateCollabPreferences(groupId, parseProfile(profileForm));
      profileDirty.current = false;
      setMessage("Your trip-specific preferences are saved.");
      setRefreshKey((current) => current + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function saveObjectives() {
    if (!group) return;
    await runAction(async () => {
      await updateCollabGroup(groupId, {
        objectives: { ...group.objectives, interests: splitList(objectiveInterests), must_include: splitList(objectiveMustInclude) },
      });
      objectivesDirty.current = false;
    }, "Group objectives updated.");
  }

  async function copyInviteCode() {
    if (!group || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(group.invite_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Copy failed. Select and copy the invite code manually.");
    }
  }

  async function addToWishlist(experienceId: string) {
    await runAction(() => addCollabWishlistItem(groupId, experienceId), "Added to the shared wishlist.");
  }

  async function savePlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!wishlist.length || !selectedPlanCount) return;
    const items = wishlist
      .filter((item) => planSelection[item.experience.id])
      .map((item) => ({ experience_id: item.experience.id, is_optional: Boolean(optionalSelection[item.experience.id]) }));
    await runAction(async () => {
      const saved = await updateCollabPlan(groupId, planTitle, items);
      setPlan(saved);
      planDirty.current = false;
    }, "Plan saved and sent to members for review.");
  }

  async function submitDecision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const selected = wishlist.filter((item) => decisionOptionIds.includes(item.experience.id));
    if (selected.length < 2) return;
    await runAction(async () => {
      await createCollabDecision(groupId, decisionTitle, selected.map((item) => ({
        label: item.experience.title,
        experience_id: item.experience.id,
      })));
      setDecisionTitle("");
      setDecisionOptionIds([]);
    }, "Vote created.");
  }

  if (loading && !group) {
    return <PageContainer className="space-y-5 py-8" aria-busy="true"><Skeleton className="h-12 w-80 rounded-2xl" /><Skeleton className="h-40 rounded-3xl" /><Skeleton className="h-80 rounded-3xl" /></PageContainer>;
  }
  if (error && !group) {
    return <PageContainer className="py-10"><ErrorState title="Couldn’t open this group" description={error} onRetry={() => { setLoading(true); setError(null); setRefreshKey((value) => value + 1); }} /></PageContainer>;
  }
  if (!group) return null;

  const commonValues = Object.entries(analysis?.common ?? {}).flatMap(([name, values]) => values.map((value) => `${name.replaceAll("_", " ")}: ${value}`));
  const flexibleValues = Object.entries(analysis?.flexible ?? {}).flatMap(([name, values]) => values.map((value) => `${name.replaceAll("_", " ")}: ${value}`));
  const conflictValues = Object.entries(analysis?.conflicts ?? {}).map(([name, votes]) => `${name.replaceAll("_", " ")}: ${Object.entries(votes).map(([value, count]) => `${value} (${count})`).join(" vs ")}`);
  const groupDirectionValues = Object.entries(analysis?.group_direction ?? {}).map(([name, value]) => `${name.replaceAll("_", " ")}: ${value}`);
  const openDecisionCount = decisions.filter((decision) => decision.status === "OPEN").length;

  return (
    <PageContainer className="space-y-8 py-7 sm:py-9">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/collab" className="inline-flex items-center gap-2 text-sm font-medium text-ink-muted transition hover:text-ink"><ArrowLeft className="size-4" aria-hidden="true" />All groups</Link>
        <Button variant="outline" size="sm" onClick={() => setRefreshKey((value) => value + 1)}><RefreshCw className="size-4" aria-hidden="true" />Refresh</Button>
      </div>

      <header className="flex flex-col gap-4 rounded-3xl border border-line bg-pastel-lavender/40 p-5 shadow-soft sm:flex-row sm:items-start sm:justify-between sm:p-7">
        <div className="min-w-0 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">Collaborative trip</p>
          <h1 className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">{group.title}</h1>
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-ink-muted">
            <span className="inline-flex items-center gap-1.5"><MapPin className="size-4" aria-hidden="true" />{group.destination || "Destination not set"}</span>
            <span className="inline-flex items-center gap-1.5"><CalendarDays className="size-4" aria-hidden="true" />{group.itinerary_date || "Date flexible"}{group.start_time ? ` · ${group.start_time.slice(0, 5)}–${group.end_time?.slice(0, 5)}` : ""}</span>
            <span className="inline-flex items-center gap-1.5"><UsersRound className="size-4" aria-hidden="true" />{group.members.length} members</span>
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-2 rounded-2xl border border-line bg-surface/90 p-3 sm:max-w-xs sm:p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Private invite code</p>
          <code className="break-all text-sm font-semibold text-ink">{group.invite_code}</code>
          <Button type="button" size="sm" variant="outline" onClick={() => void copyInviteCode()}>
            {copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}{copied ? "Copied" : "Copy code"}
          </Button>
        </div>
      </header>

      {error ? <p role="alert" className="rounded-xl border border-danger/20 bg-danger-soft px-4 py-3 text-sm text-danger">{error}</p> : null}
      {message ? <p role="status" className="rounded-xl border border-success/20 bg-success-soft px-4 py-3 text-sm text-ink">{message}</p> : null}

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)] xl:items-start">
        <div className="space-y-8">
          <Section title="Group recommendations" description="Active real places are ranked against shared preferences and hard limits. Unknown venue hours or capacity stay clearly marked for confirmation.">
            <Card><CardBody className="space-y-4 p-5">
              <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); setActiveQuery(search.trim()); }}><Input aria-label="Search group recommendations" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search experiences" /><Button type="submit" size="sm">Search</Button></form>
              {recommendationWarnings.map((warning) => <p key={warning} className="rounded-xl bg-warning-soft px-3 py-2 text-xs leading-5 text-ink">{warning}</p>)}
              {recommendations.length ? <div className="space-y-3">{recommendations.map((recommendation) => <RecommendationCard key={recommendation.experience.id} recommendation={recommendation} inWishlist={wishlist.some((item) => item.experience.id === recommendation.experience.id)} saving={saving} onAdd={() => void addToWishlist(recommendation.experience.id)} />)}</div> : <p className="rounded-2xl border border-dashed border-line-strong p-4 text-sm leading-6 text-ink-muted">No catalog place currently fits the group’s known budget, distance, and accessibility limits. Try a wider search or update the group preferences.</p>}
            </CardBody></Card>
          </Section>

          <Section title="Shared wishlist" description="React to real catalog experiences. The group can turn wishlist items into a decision or a reviewable itinerary.">
            {wishlist.length === 0 ? <EmptyState icon={MapPin} title="Your shared wishlist is empty" description="Add a real, feasible experience from the recommendations to get started." /> : (
              <div className="space-y-3">{wishlist.map((item) => <Card key={item.id}><CardBody className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0"><h3 className="font-semibold text-ink">{item.experience.title}</h3><p className="mt-1 text-xs text-ink-muted">{item.experience.category.name} · {item.experience.location.place_name || item.experience.location.locality || item.experience.location.city}{item.experience.price != null ? ` · ₹${item.experience.price}` : " · Price unavailable"}</p><p className="mt-2 text-sm text-ink-muted">{item.experience.short_description}</p><div className="mt-2 flex flex-wrap gap-1.5">{item.reactions.map((reaction) => <Badge key={reaction.member_id} tone={reaction.reaction === "like" ? "success" : reaction.reaction === "dislike" ? "danger" : "neutral"}>{reaction.email.split("@")[0]} · {reaction.reaction}</Badge>)}</div></div>
                <div className="flex shrink-0 flex-wrap gap-2">{(["like", "maybe", "dislike"] as const).map((reaction) => <Button key={reaction} size="sm" variant={item.my_reaction === reaction ? "secondary" : "outline"} disabled={saving} onClick={() => void runAction(() => reactToCollabWishlistItem(groupId, item.id, reaction))}>{reaction[0].toUpperCase() + reaction.slice(1)}</Button>)}{(isOwner || item.added_by_member_id === group.my_member_id) ? <Button size="sm" variant="ghost" disabled={saving} onClick={() => void runAction(() => removeCollabWishlistItem(groupId, item.id), "Removed from wishlist.")}>Remove</Button> : null}</div>
              </CardBody></Card>)}</div>
            )}
          </Section>

          <Section title="Collaborative itinerary" description="Build from the shared wishlist. Optional activities stay as branches; required stops must pass the existing itinerary validation before trips are created.">
            <Card><CardBody className="space-y-4 p-5">
              {plan?.status === "FINALIZED" ? <div className="space-y-3"><Badge tone="success">Finalized</Badge><p className="text-sm text-ink-muted">The approved schedule is now saved in each traveler’s existing Trips data.</p>{myTripId ? <Link href={`/trip/${myTripId}`}><Button className="w-full">Open my trip</Button></Link> : <p className="text-xs text-ink-muted">Your trip record is linked. Open Trips to view it.</p>}</div> : <>
                <form className="space-y-3" onSubmit={(event) => void savePlan(event)}>
                  <Input label="Plan title" value={planTitle} onChange={(event) => { setPlanTitle(event.target.value); planDirty.current = true; }} required maxLength={200} />
                  {wishlist.length ? <fieldset className="space-y-2"><legend className="text-sm font-medium text-ink">Activities</legend>{wishlist.map((item) => <div key={item.id} className="flex items-center gap-2 rounded-2xl border border-line p-3"><label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-ink"><input type="checkbox" checked={Boolean(planSelection[item.experience.id])} onChange={(event) => { setPlanSelection({ ...planSelection, [item.experience.id]: event.target.checked }); planDirty.current = true; }} /><span className="truncate">{item.experience.title}</span></label>{planSelection[item.experience.id] ? <label className="flex shrink-0 items-center gap-1.5 text-xs text-ink-muted"><input type="checkbox" checked={Boolean(optionalSelection[item.experience.id])} onChange={(event) => { setOptionalSelection({ ...optionalSelection, [item.experience.id]: event.target.checked }); planDirty.current = true; }} />Optional branch</label> : null}</div>)}</fieldset> : <p className="text-sm text-ink-muted">Add experiences to the wishlist first.</p>}
                  <Button type="submit" size="sm" disabled={!selectedPlanCount || saving} loading={saving}>Save and request review</Button>
                </form>
                {plan?.status === "DRAFT" ? <p className="border-t border-line pt-4 text-xs text-ink-muted">The plan changed. Save its current activities to request member approval again.</p> : null}
                {plan?.status === "REVIEW" ? <div className="space-y-3 border-t border-line pt-4"><p className="flex flex-wrap items-center justify-between gap-2 text-sm font-semibold text-ink"><span>Member review</span><Badge tone="accent">{plan.approvals.filter((approval) => approval.status === "APPROVED").length}/{group.members.length} approved</Badge></p><div className="space-y-2">{plan.items.map((item) => <div key={item.id} className="flex items-center justify-between gap-2 rounded-xl bg-surface-sunken px-3 py-2 text-sm"><span className="truncate text-ink">{item.sequence_order}. {item.experience.title}</span><Badge tone={item.is_optional ? "neutral" : "accent"}>{item.is_optional ? "Optional" : "Required"}</Badge></div>)}</div><div className="space-y-2">{plan.approvals.map((approval) => <div key={approval.member_id} className="flex items-center justify-between gap-2 text-xs text-ink-muted"><span className="truncate">{approval.email}</span><Badge tone={approval.status === "APPROVED" ? "success" : approval.status === "REVISION_REQUESTED" ? "warning" : "neutral"}>{approval.status.replaceAll("_", " ")}</Badge></div>)}</div><div className="flex flex-wrap gap-2"><Button size="sm" variant={currentApproval?.status === "APPROVED" ? "secondary" : "outline"} disabled={saving} onClick={() => void runAction(() => reviewCollabPlan(groupId, "APPROVED"), "Your approval is recorded.")}>{currentApproval?.status === "APPROVED" ? "Approved" : "Approve plan"}</Button><Button size="sm" variant="ghost" disabled={saving} onClick={() => { const note = window.prompt("What should the group revise?") || ""; if (note) void runAction(() => reviewCollabPlan(groupId, "REVISION_REQUESTED", note), "Revision request sent."); }}>Request changes</Button></div><Button className="w-full" disabled={!allApproved || saving} loading={saving} onClick={() => void runAction(() => finalizeCollabPlan(groupId), "Finalized. Your trip is available in Trips.")}>Finalize for all members</Button>{!allApproved ? <p className="text-xs text-ink-subtle">Every active member must approve the current version.</p> : null}</div> : null}
              </>}
            </CardBody></Card>
          </Section>
        </div>

        <aside className="space-y-8 xl:sticky xl:top-5">
          <details className="group rounded-3xl border border-line bg-surface p-5 shadow-soft sm:p-6">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent">
              <span>
                <span className="block text-lg font-semibold tracking-tight text-ink">Group preferences and controls</span>
                <span className="mt-1 block text-sm leading-6 text-ink-muted">Edit preferences, review members, set shared goals, or manage votes · {group.members.length} members · {openDecisionCount} open votes</span>
              </span>
              <ChevronDown className="size-5 shrink-0 text-ink-muted transition-transform group-open:rotate-180" aria-hidden="true" />
            </summary>
            <div className="mt-6 space-y-8">
              <Section title="Group preference profile" description="Neutral members don’t cancel another member’s stated preference. Hard limits are applied before soft preference ranking.">
            <Card><CardBody className="space-y-5 p-5 sm:p-6">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="rounded-2xl bg-pastel-mint/45 p-4"><p className="mb-2 text-sm font-semibold text-ink">Common</p><TagList values={commonValues} /></div>
                <div className="rounded-2xl bg-pastel-sky/35 p-4"><p className="mb-2 text-sm font-semibold text-ink">Flexible</p><TagList values={flexibleValues} /></div>
                <div className="rounded-2xl bg-pastel-rose/35 p-4"><p className="mb-2 text-sm font-semibold text-ink">Conflicts</p><TagList values={conflictValues} /></div>
              </div>
              {groupDirectionValues.length ? <div className="rounded-2xl border border-accent/15 bg-accent-soft/40 p-4"><p className="mb-2 text-sm font-semibold text-ink">Current group direction</p><TagList values={groupDirectionValues} /></div> : null}
              {analysis?.warnings.map((warning) => <p key={warning} className="rounded-xl border border-warning/20 bg-warning-soft px-4 py-3 text-xs leading-5 text-ink">{warning}</p>)}
            </CardBody></Card>
          </Section>

          <Section title="Individual member profiles" description="Each profile is scoped to this group and never overwrites a member’s permanent traveler preferences.">
            <div className="grid gap-3 md:grid-cols-2">
              {group.members.map((member) => (
                <Card key={member.id}><CardBody className="space-y-3 p-4">
                  <div className="flex items-center justify-between gap-2"><div className="min-w-0"><p className="truncate font-semibold text-ink">{member.email}</p><p className="text-xs capitalize text-ink-muted">{member.role}</p></div>{isOwner && member.role !== "owner" ? <Button size="sm" variant="ghost" disabled={saving} onClick={() => void runAction(() => removeCollabMember(groupId, member.id), "Member removed.")}>Remove</Button> : null}</div>
                  <div className="space-y-1 text-xs text-ink-muted"><p><span className="font-medium text-ink">Interests:</span> {formatList(member.soft_preferences.interests) || "Flexible"}</p><p><span className="font-medium text-ink">Food:</span> {formatList(member.soft_preferences.food_preferences) || "Flexible"}</p><p><span className="font-medium text-ink">Activities:</span> {formatList(member.soft_preferences.activities) || "Flexible"}</p>{member.soft_preferences.category_slugs?.length || member.soft_preferences.budget_sensitivity || member.soft_preferences.preferred_duration_minutes != null ? <p><span className="font-medium text-ink">Existing traveler preferences copied into this group:</span> {[member.soft_preferences.category_slugs?.length ? `categories ${member.soft_preferences.category_slugs.join(", ")}` : "", member.soft_preferences.budget_sensitivity ? `budget ${member.soft_preferences.budget_sensitivity}` : "", member.soft_preferences.preferred_duration_minutes != null ? `${member.soft_preferences.preferred_duration_minutes} min preferred activity duration` : ""].filter(Boolean).join(" · ")}</p> : null}<p><span className="font-medium text-ink">Hard limits:</span> {member.hard_constraints.budget_max != null ? `₹${member.hard_constraints.budget_max} budget · ` : ""}{member.hard_constraints.max_distance_km != null ? `${member.hard_constraints.max_distance_km} km max · ` : ""}{safeList(member.hard_constraints.accessibility_requirements).join(", ") || "None set"}</p></div>
                </CardBody></Card>
              ))}
            </div>
          </Section>

          <Section title="My trip preferences" description="Tell the group what you enjoy, what you avoid, and which limits the recommendations must honor.">
            <Card><CardBody className="p-5 sm:p-6">
              <form className="space-y-5" onSubmit={(event) => void saveProfile(event)}>
                <div className="grid gap-4 md:grid-cols-2">
                  <Textarea label="Interests (comma separated)" value={profileForm.interests} onChange={(event) => { setProfileForm({ ...profileForm, interests: event.target.value }); profileDirty.current = true; }} placeholder="beach, heritage, photography" />
                  <Textarea label="Food preferences" value={profileForm.food_preferences} onChange={(event) => { setProfileForm({ ...profileForm, food_preferences: event.target.value }); profileDirty.current = true; }} placeholder="street food, vegetarian" />
                  <Textarea label="Activities" value={profileForm.activities} onChange={(event) => { setProfileForm({ ...profileForm, activities: event.target.value }); profileDirty.current = true; }} placeholder="walking tours, markets" />
                  <Textarea label="Dislikes" value={profileForm.dislikes} onChange={(event) => { setProfileForm({ ...profileForm, dislikes: event.target.value }); profileDirty.current = true; }} placeholder="crowded venues, long hikes" />
                </div>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">Pace<select className="h-11 rounded-2xl border border-line-strong bg-surface-raised px-3" value={profileForm.pace} onChange={(event) => { setProfileForm({ ...profileForm, pace: event.target.value as ProfileForm["pace"] }); profileDirty.current = true; }}><option value="">No preference</option><option value="relaxed">Relaxed</option><option value="balanced">Balanced</option><option value="packed">Packed</option></select></label>
                  <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">Crowd preference<select className="h-11 rounded-2xl border border-line-strong bg-surface-raised px-3" value={profileForm.crowd_preference} onChange={(event) => { setProfileForm({ ...profileForm, crowd_preference: event.target.value as ProfileForm["crowd_preference"] }); profileDirty.current = true; }}><option value="">Neutral</option><option value="low">Prefer low crowd</option><option value="medium">Medium crowd</option><option value="high">Crowds are fine</option></select></label>
                  <Input label="Age (trip-specific)" type="number" min={0} max={120} value={profileForm.age} onChange={(event) => { setProfileForm({ ...profileForm, age: event.target.value }); profileDirty.current = true; }} hint="The current catalog has no verified age-limit data." />
                  <Input label="Walking tolerance (km)" type="number" min={0} max={100} step="any" value={profileForm.walking_tolerance_km} onChange={(event) => { setProfileForm({ ...profileForm, walking_tolerance_km: event.target.value }); profileDirty.current = true; }} />
                  <Input label="Max budget (INR)" type="number" min={0} step="any" value={profileForm.budget_max} onChange={(event) => { setProfileForm({ ...profileForm, budget_max: event.target.value }); profileDirty.current = true; }} hint="The tightest member cap is applied." />
                  <Input label="Max distance (km)" type="number" min={0.1} max={1000} step="any" value={profileForm.max_distance_km} onChange={(event) => { setProfileForm({ ...profileForm, max_distance_km: event.target.value }); profileDirty.current = true; }} hint="Requires a group starting coordinate." />
                </div>
                <fieldset className="flex flex-wrap gap-4 rounded-2xl border border-line p-4">
                  <legend className="px-1 text-sm font-medium text-ink">Accessibility hard constraints</legend>
                  {(["wheelchair_accessible", "step_free"] as const).map((requirement) => <label key={requirement} className="inline-flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={profileForm.accessibility_requirements.includes(requirement)} onChange={(event) => { const values = event.target.checked ? [...profileForm.accessibility_requirements, requirement] : profileForm.accessibility_requirements.filter((item) => item !== requirement); setProfileForm({ ...profileForm, accessibility_requirements: values }); profileDirty.current = true; }} />{requirement === "step_free" ? "Step-free access" : "Wheelchair accessible"}</label>)}
                </fieldset>
                {profileForm.age ? <p className="rounded-xl bg-warning-soft px-4 py-3 text-xs leading-5 text-ink">Age limits cannot be verified from the current catalog. Recommendations are withheld until that catalog data exists.</p> : null}
                <div className="flex justify-end border-t border-line pt-4"><Button type="submit" loading={saving}>Save my preferences</Button></div>
              </form>
            </CardBody></Card>
          </Section>

              <Section title="Decisions and voting" description="Make a focused choice from the shared wishlist. Each member can change their vote until the owner closes it.">
            {wishlist.length >= 2 ? <Card><CardBody className="p-5">
              <form className="space-y-4" onSubmit={(event) => void submitDecision(event)}>
                <Input label="Decision question" value={decisionTitle} onChange={(event) => setDecisionTitle(event.target.value)} required minLength={3} maxLength={200} placeholder="Which stop should we choose?" />
                <fieldset className="flex flex-wrap gap-2"><legend className="mb-2 w-full text-sm font-medium text-ink">Choose at least two wishlist options</legend>{wishlist.map((item) => <label key={item.id} className={`cursor-pointer rounded-full border px-3 py-2 text-xs transition ${decisionOptionIds.includes(item.experience.id) ? "border-accent bg-accent-soft text-accent" : "border-line text-ink-muted hover:bg-surface-sunken"}`}><input className="sr-only" type="checkbox" checked={decisionOptionIds.includes(item.experience.id)} onChange={(event) => setDecisionOptionIds((current) => event.target.checked ? [...current, item.experience.id] : current.filter((id) => id !== item.experience.id))} />{item.experience.title}</label>)}</fieldset>
                <div className="flex justify-end"><Button type="submit" disabled={decisionOptionIds.length < 2 || saving} loading={saving}>Start vote</Button></div>
              </form>
            </CardBody></Card> : null}
            {decisions.length ? <div className="space-y-3">{decisions.map((decision) => {
              const myVote = decision.votes.find((vote) => vote.member_id === group.my_member_id)?.option_id;
              return <Card key={decision.id}><CardBody className="space-y-4 p-4 sm:p-5"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold text-ink">{decision.title}</h3><Badge tone={decision.status === "OPEN" ? "accent" : "neutral"}>{decision.status === "OPEN" ? "Voting open" : "Closed"}</Badge></div><div className="grid gap-2 sm:grid-cols-2">{decision.options.map((option) => <div key={option.id} className="flex items-center justify-between gap-3 rounded-2xl border border-line p-3"><div className="min-w-0"><p className="truncate text-sm font-medium text-ink">{option.label}</p><p className="text-xs text-ink-muted">{option.vote_count} vote{option.vote_count === 1 ? "" : "s"}</p></div><Button size="sm" variant={myVote === option.id ? "secondary" : "outline"} disabled={decision.status !== "OPEN" || saving} onClick={() => void runAction(() => voteCollabDecision(groupId, decision.id, option.id))}>{myVote === option.id ? "Your vote" : "Vote"}</Button></div>)}</div><div className="flex flex-wrap items-center justify-between gap-2">{decision.votes.length ? <p className="text-xs text-ink-muted">Voted: {decision.votes.map((vote) => vote.email.split("@")[0]).join(", ")}</p> : <span />}{isOwner && decision.status === "OPEN" ? <Button size="sm" variant="ghost" disabled={saving} onClick={() => void runAction(() => closeCollabDecision(groupId, decision.id))}>Close vote</Button> : null}</div></CardBody></Card>;
            })}</div> : null}
          </Section>

              <Section title="Group objectives" description="Shared goals contribute to the recommendation score.">
            <Card><CardBody className="space-y-4 p-5">
              <Textarea label="Interests" value={objectiveInterests} disabled={!isOwner} onChange={(event) => { setObjectiveInterests(event.target.value); objectivesDirty.current = true; }} placeholder="heritage, local food" />
              <Textarea label="Must include" value={objectiveMustInclude} disabled={!isOwner} onChange={(event) => { setObjectiveMustInclude(event.target.value); objectivesDirty.current = true; }} placeholder="a market, a beach" />
              {isOwner ? <Button size="sm" variant="outline" disabled={saving} onClick={() => void saveObjectives()}>Save group goals</Button> : <p className="text-xs text-ink-muted">The group owner can edit shared objectives.</p>}
            </CardBody></Card>
          </Section>
            </div>
          </details>
        </aside>
      </div>
    </PageContainer>
  );
}

function RecommendationCard({ recommendation, inWishlist, saving, onAdd }: { recommendation: CollabRecommendation; inWishlist: boolean; saving: boolean; onAdd: () => void }) {
  const experience = recommendation.experience;
  const price = experience.price ?? experience.maximum_price ?? experience.minimum_price;
  const priceLabel = price == null
    ? "Venue price not listed"
    : experience.is_price_estimated && experience.minimum_price != null && experience.maximum_price != null
      ? `Est. ₹${Math.round(experience.minimum_price)}–₹${Math.round(experience.maximum_price)}`
      : `${experience.is_price_estimated ? "Est. " : "Listed "}₹${Math.round(price)}`;
  const score = recommendation.compatibility_score;
  return (
    <article className="rounded-2xl border border-line bg-surface-raised p-4 transition duration-200 hover:-translate-y-0.5 hover:shadow-md">
      <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="font-semibold text-ink">{experience.title}</h3><p className="mt-1 text-xs text-ink-muted">{experience.category.name} · {experience.location.place_name || experience.location.locality || experience.location.city}</p></div><Badge tone="success">{score}% match</Badge></div>
      <div className="mt-2 flex flex-wrap gap-1.5"><Badge tone={recommendation.schedule_status === "VERIFIED" ? "success" : "warning"}>{recommendation.schedule_status === "VERIFIED" ? "Hours and capacity checked" : "Confirm hours and availability"}</Badge>{recommendation.hard_constraint_status === "UNKNOWN" ? <Badge tone="warning">Some group limits need checking</Badge> : null}</div>
      <p className="mt-2 line-clamp-2 text-sm leading-5 text-ink-muted">{experience.short_description}</p>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-subtle"><span>{priceLabel}</span>{experience.duration_minutes != null ? <span>{experience.duration_is_estimated ? "~" : ""}{experience.duration_minutes} min</span> : null}<span>{experience.provider.business_name}</span></div>
      {recommendation.matched_preferences.length ? <div className="mt-3 flex flex-wrap gap-1.5">{recommendation.matched_preferences.slice(0, 4).map((signal) => <Badge key={signal} tone="neutral">{signal}</Badge>)}</div> : <p className="mt-3 text-xs text-ink-subtle">No explicit preference match; shown from group objectives.</p>}
      <Button className="mt-4 w-full" size="sm" variant={inWishlist ? "secondary" : "outline"} disabled={inWishlist || saving} onClick={onAdd}>{inWishlist ? "In shared wishlist" : "Add to wishlist"}</Button>
    </article>
  );
}
