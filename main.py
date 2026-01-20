from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from typing import List, Dict
import json

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ConnectionManager:
    def __init__(self):
        # Yapı: { "oda_id": [ {"ws": WebSocket, "name": "Yusuf"}, ... ] }
        self.rooms: Dict[str, List[dict]] = {}

    async def connect(self, websocket: WebSocket, room_id: str, username: str):
        await websocket.accept()
        if room_id not in self.rooms:
            self.rooms[room_id] = []
        self.rooms[room_id].append({"ws": websocket, "name": username})
        await self.broadcast_user_list(room_id)

    def disconnect(self, websocket: WebSocket, room_id: str):
        if room_id in self.rooms:
            self.rooms[room_id] = [user for user in self.rooms[room_id] if user["ws"] != websocket]
            if not self.rooms[room_id]:
                del self.rooms[room_id]

    async def broadcast(self, message: dict, room_id: str):
        if room_id in self.rooms:
            for user in self.rooms[room_id][:]:
                try:
                    await user["ws"].send_json(message)
                except:
                    pass

    async def broadcast_user_list(self, room_id: str):
        if room_id in self.rooms:
            user_names = [user["name"] for user in self.rooms[room_id]]
            message = {
                "type": "USER_LIST",
                "users": user_names,
                "count": len(user_names)
            }
            await self.broadcast(message, room_id)

manager = ConnectionManager()

@app.get("/")
def read_root():
    return {"Status": "Co Watch Server (v6.0 Ping-Pong Stable) 🚀"}

@app.websocket("/ws/{room_id}/{username}")
async def websocket_endpoint(websocket: WebSocket, room_id: str, username: str):
    await manager.connect(websocket, room_id, username)
    try:
        await manager.broadcast({
            "type": "SYSTEM",
            "message": f"{username} odaya katıldı."
        }, room_id)
        
        while True:
            try:
                data = await websocket.receive_json()
            except Exception:
                break 

            msg_type = data.get("type")

            # 1. GECİKME ÖLÇER (Milisaniye hesabı için)
            if msg_type == "PING_MEASURE":
                await websocket.send_json(data)
                continue
            
            # 2. KALP ATIŞI (Keep-Alive) - GÜNCELLENDİ
            # Artık sunucu sessiz kalmıyor, "PONG" cevabı dönüyor.
            # Bu, bağlantının çift yönlü aktif kalmasını sağlar.
            if msg_type == "PING":
                await websocket.send_json({"type": "PONG"})
                continue

            if msg_type == "SIGNAL":
                pass 

            if msg_type == "URL_CHANGE":
                pass

            response = { "user": username, **data }
            await manager.broadcast(response, room_id)

    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(websocket, room_id)
        await manager.broadcast_user_list(room_id)
        try:
            await manager.broadcast({
                "type": "SYSTEM",
                "message": f"{username} ayrıldı."
            }, room_id)
        except:
            pass