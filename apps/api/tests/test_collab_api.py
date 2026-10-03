from __future__ import annotations

from tests.conftest import auth_header, register_traveler


def test_collaboration_group_create_join_and_membership_are_authenticated(discovery_client) -> None:
    owner = register_traveler(discovery_client, "collab-owner@example.com")
    guest = register_traveler(discovery_client, "collab-guest@example.com")

    assert discovery_client.post("/api/v1/collab/groups", json={"title": "Shared Mumbai trip"}).status_code == 401
    created = discovery_client.post(
        "/api/v1/collab/groups",
        json={"title": "Shared Mumbai trip", "destination": "Mumbai"},
        headers=auth_header(owner),
    )
    assert created.status_code == 201, created.text
    group = created.json()
    assert group["title"] == "Shared Mumbai trip"
    assert group["my_member_id"]
    assert group["invite_code"]
    assert len(group["members"]) == 1

    joined = discovery_client.post(
        "/api/v1/collab/join",
        json={"invite_code": group["invite_code"]},
        headers=auth_header(guest),
    )
    assert joined.status_code == 200, joined.text
    assert len(joined.json()["members"]) == 2

    for member in (owner, guest):
        groups = discovery_client.get("/api/v1/collab/groups", headers=auth_header(member))
        assert groups.status_code == 200
        assert [entry["id"] for entry in groups.json()] == [group["id"]]

    outsider = register_traveler(discovery_client, "collab-outsider@example.com")
    denied = discovery_client.get(
        f"/api/v1/collab/groups/{group['id']}", headers=auth_header(outsider)
    )
    assert denied.status_code == 404


def test_recommendations_return_real_catalog_shortlist_when_hours_are_unknown(client) -> None:
    owner = register_traveler(client, "collab-recommendations@example.com")
    group = client.post(
        "/api/v1/collab/groups",
        json={
            "title": "Dated Mumbai plan",
            "destination": "Mumbai",
            "itinerary_date": "2026-10-12",
            "start_time": "10:00:00",
            "end_time": "18:00:00",
            "origin_latitude": 18.93,
            "origin_longitude": 72.83,
        },
        headers=auth_header(owner),
    )
    assert group.status_code == 201, group.text

    response = client.get(
        f"/api/v1/collab/groups/{group.json()['id']}/recommendations",
        headers=auth_header(owner),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["items"]
    recommendation = body["items"][0]
    assert recommendation["experience"]["is_synthetic"] is False
    assert recommendation["schedule_status"] == "NEEDS_CONFIRMATION"

    saved = client.post(
        f"/api/v1/collab/groups/{group.json()['id']}/wishlist",
        json={"experience_id": recommendation["experience"]["id"]},
        headers=auth_header(owner),
    )
    assert saved.status_code == 201, saved.text
