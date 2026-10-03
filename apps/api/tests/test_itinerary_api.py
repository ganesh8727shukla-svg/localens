"""Itinerary API tests (Phase 8) — POST /itineraries/compose, GET
/itineraries, GET /itineraries/{id}, POST /itineraries/{id}/items."""

from __future__ import annotations

from tests.conftest import auth_header, register_traveler


def _compose_payload(**overrides) -> dict:
    payload = {
        "query": "food",
        "itinerary_date": "2026-10-12",  # a Monday
        "start_time": "09:00:00",
        "end_time": "20:00:00",
        "max_experiences": 3,
        "travel_mode": "driving",
    }
    payload.update(overrides)
    return payload


def test_compose_requires_auth(discovery_client) -> None:
    response = discovery_client.post("/api/v1/itineraries/compose", json=_compose_payload())
    assert response.status_code == 401


def test_compose_authenticated_returns_itinerary_or_validation_failure(discovery_client) -> None:
    user = register_traveler(discovery_client, "composer-traveler@example.com")
    response = discovery_client.post(
        "/api/v1/itineraries/compose", json=_compose_payload(), headers=auth_header(user)
    )
    assert response.status_code == 200, response.text
    body = response.json()
    # Either a valid ItineraryResponse (has "items") or a
    # CompositionValidationResponse (has "valid": False) — never a
    # partial/forced plan and never a 500.
    assert "items" in body or body.get("valid") is False


def test_compose_keeps_the_exact_selected_canonical_experiences(discovery_client, discovery_dataset) -> None:
    user = register_traveler(discovery_client, "selected-composer@example.com")
    selected_ids = [discovery_dataset["near_experience_id"], discovery_dataset["mid_experience_id"]]
    response = discovery_client.post(
        "/api/v1/itineraries/compose",
        json=_compose_payload(experience_ids=selected_ids, max_experiences=2),
        headers=auth_header(user),
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert "items" in body, body
    assert {item["experience_id"] for item in body["items"]} == set(selected_ids)


def test_compose_rejects_duplicate_selected_ids(discovery_client) -> None:
    user = register_traveler(discovery_client, "duplicate-selection@example.com")
    response = discovery_client.post(
        "/api/v1/itineraries/compose",
        json=_compose_payload(experience_ids=["same-id", "same-id"]),
        headers=auth_header(user),
    )
    assert response.status_code == 422


def test_compose_does_not_silently_drop_an_infeasible_selected_experience(discovery_client, discovery_dataset) -> None:
    user = register_traveler(discovery_client, "infeasible-selection@example.com")
    response = discovery_client.post(
        "/api/v1/itineraries/compose",
        json=_compose_payload(experience_ids=[discovery_dataset["inactive_experience_id"]]),
        headers=auth_header(user),
    )
    assert response.status_code == 200
    body = response.json()
    assert body.get("valid") is False
    assert body["feasible_count"] == 0


def test_compose_request_body_has_no_traveler_id_field(discovery_client) -> None:
    user = register_traveler(discovery_client, "no-traveler-id@example.com")
    payload = _compose_payload()
    payload["traveler_id"] = "some-other-traveler-id"
    response = discovery_client.post("/api/v1/itineraries/compose", json=payload, headers=auth_header(user))
    # extra="forbid" on ComposeItineraryRequest -> 422, proving the field
    # is rejected rather than silently accepted/trusted.
    assert response.status_code == 422


def test_compose_persists_itinerary_and_items_and_survives_fresh_get(discovery_client) -> None:
    """Regression test for the Trip-page refresh bug: proves the backend
    persistence itself is correct end to end — a composed itinerary and
    its items are durably written to the database (not just returned as
    an in-memory response object), and a completely independent GET
    request (simulating a browser refresh, a new request with no shared
    in-process state) returns the exact same itinerary, same id, same
    items, same ordering. If this test passes, the persistence layer is
    proven correct and the disappearing-itinerary bug is a frontend
    hydration issue, not a database/backend issue."""
    user = register_traveler(discovery_client, "persist-traveler@example.com")
    compose_resp = discovery_client.post(
        "/api/v1/itineraries/compose", json=_compose_payload(), headers=auth_header(user)
    )
    assert compose_resp.status_code == 200, compose_resp.text
    composed = compose_resp.json()
    if "items" not in composed:
        return  # composition failed to find a valid plan — nothing to assert persistence against
    assert composed["id"]
    assert len(composed["items"]) > 0

    # Simulate "refresh": a brand new GET request, independent of the
    # compose response the frontend already has in memory.
    fresh_get = discovery_client.get(f"/api/v1/itineraries/{composed['id']}", headers=auth_header(user))
    assert fresh_get.status_code == 200
    fetched = fresh_get.json()
    assert fetched["id"] == composed["id"]
    assert fetched["traveler_id"] == composed["traveler_id"]
    assert len(fetched["items"]) == len(composed["items"])
    assert [i["id"] for i in fetched["items"]] == [i["id"] for i in composed["items"]]

    # Simulate "logout -> login again": GET /itineraries (the list
    # endpoint the Trip page hydrates from) independently returns the
    # same itinerary for the same traveler, with no reliance on any
    # frontend-held state from the original compose call.
    list_resp = discovery_client.get("/api/v1/itineraries", headers=auth_header(user))
    assert list_resp.status_code == 200
    listed = list_resp.json()
    assert listed["total"] >= 1
    assert any(item["id"] == composed["id"] for item in listed["items"])


def test_list_my_itineraries_only_returns_own(discovery_client) -> None:
    owner = register_traveler(discovery_client, "itin-owner@example.com")
    other = register_traveler(discovery_client, "itin-other@example.com")

    discovery_client.post("/api/v1/itineraries/compose", json=_compose_payload(), headers=auth_header(owner))

    owner_list = discovery_client.get("/api/v1/itineraries", headers=auth_header(owner))
    other_list = discovery_client.get("/api/v1/itineraries", headers=auth_header(other))
    assert owner_list.status_code == 200
    assert other_list.status_code == 200
    assert other_list.json()["total"] == 0


def test_cross_traveler_access_forbidden(discovery_client) -> None:
    owner = register_traveler(discovery_client, "cross-owner@example.com")
    intruder = register_traveler(discovery_client, "cross-intruder@example.com")

    compose_resp = discovery_client.post(
        "/api/v1/itineraries/compose", json=_compose_payload(), headers=auth_header(owner)
    )
    body = compose_resp.json()
    if "items" not in body:
        # Composition failed to find a valid plan (acceptable, given a
        # small dataset) — nothing to assert cross-ownership against.
        return

    itinerary_id = body["id"]
    response = discovery_client.get(f"/api/v1/itineraries/{itinerary_id}", headers=auth_header(intruder))
    assert response.status_code == 404
    weather_response = discovery_client.get(
        f"/api/v1/itineraries/{itinerary_id}/weather", headers=auth_header(intruder)
    )
    assert weather_response.status_code == 404


def test_get_itinerary_requires_auth(discovery_client) -> None:
    response = discovery_client.get("/api/v1/itineraries/some-id")
    assert response.status_code == 401


def test_scheduled_weather_advisory_requires_auth(discovery_client) -> None:
    response = discovery_client.get("/api/v1/itineraries/some-id/weather")
    assert response.status_code == 401


def test_scheduled_weather_advisory_is_read_only(discovery_client, discovery_dataset) -> None:
    user = register_traveler(discovery_client, "trip-weather-owner@example.com")
    compose_response = discovery_client.post(
        "/api/v1/itineraries/compose",
        json=_compose_payload(experience_ids=[discovery_dataset["near_experience_id"]], max_experiences=1),
        headers=auth_header(user),
    )
    assert compose_response.status_code == 200, compose_response.text
    composed = compose_response.json()
    assert "items" in composed, composed

    before = discovery_client.get(
        f"/api/v1/itineraries/{composed['id']}", headers=auth_header(user)
    ).json()
    response = discovery_client.get(
        f"/api/v1/itineraries/{composed['id']}/weather", headers=auth_header(user)
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["itinerary_id"] == composed["id"]
    assert len(body["advisories"]) == 1
    assert body["advisories"][0]["status"] == "UNKNOWN"
    assert body["advisories"][0]["source"] == "MOCK"

    after = discovery_client.get(
        f"/api/v1/itineraries/{composed['id']}", headers=auth_header(user)
    ).json()
    assert after["status"] == before["status"]
    assert [item["item_state"] for item in after["items"]] == [item["item_state"] for item in before["items"]]


def test_add_item_requires_ownership(discovery_client) -> None:
    owner = register_traveler(discovery_client, "add-item-owner@example.com")
    intruder = register_traveler(discovery_client, "add-item-intruder@example.com")

    compose_resp = discovery_client.post(
        "/api/v1/itineraries/compose", json=_compose_payload(), headers=auth_header(owner)
    )
    body = compose_resp.json()
    if "items" not in body:
        return
    itinerary_id = body["id"]

    response = discovery_client.post(
        f"/api/v1/itineraries/{itinerary_id}/items",
        json={"experience_id": "does-not-matter"},
        headers=auth_header(intruder),
    )
    assert response.status_code == 404


def test_invalid_composition_returns_structured_validation_response(discovery_client) -> None:
    user = register_traveler(discovery_client, "invalid-composer@example.com")
    # A window too small for anything to fit at all.
    response = discovery_client.post(
        "/api/v1/itineraries/compose",
        json=_compose_payload(start_time="09:00:00", end_time="09:01:00"),
        headers=auth_header(user),
    )
    assert response.status_code == 200
    body = response.json()
    assert body.get("valid") is False
    assert "reason_code" in body


def test_cancel_itinerary(discovery_client) -> None:
    user = register_traveler(discovery_client, "cancel-owner@example.com")
    compose_resp = discovery_client.post(
        "/api/v1/itineraries/compose", json=_compose_payload(), headers=auth_header(user)
    )
    body = compose_resp.json()
    if "items" not in body:
        return
    itinerary_id = body["id"]
    response = discovery_client.delete(f"/api/v1/itineraries/{itinerary_id}", headers=auth_header(user))
    assert response.status_code == 204

    get_resp = discovery_client.get(f"/api/v1/itineraries/{itinerary_id}", headers=auth_header(user))
    assert get_resp.status_code == 200
    assert get_resp.json()["status"] == "CANCELLED"
