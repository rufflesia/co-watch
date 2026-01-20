from fastapi import WebSocket
from typing import List, Dict

class ConnectionManager:
    def __init__(self):
        # Odaları ve içindeki kullanıcıları tutan ana yapı
        # Format: {"oda_id": [WebSocket1, WebSocket2, ...]}
        self.active_connections: Dict[str, List[WebSocket]] = {}

    async def connect(self, websocket: WebSocket, room_id: str):
        # Bağlantıyı kabul et
        await websocket.accept()
        
        # Eğer oda yoksa oluştur
        if room_id not in self.active_connections:
            self.active_connections[room_id] = []
            
        # Kullanıcıyı odaya ekle
        self.active_connections[room_id].append(websocket)

    def disconnect(self, websocket: WebSocket, room_id: str):
        # Kullanıcıyı odadan çıkar
        if room_id in self.active_connections:
            if websocket in self.active_connections[room_id]:
                self.active_connections[room_id].remove(websocket)
            
            # Eğer odada kimse kalmadıysa odayı sil (Memory yönetimi)
            if len(self.active_connections[room_id]) == 0:
                del self.active_connections[room_id]

    async def broadcast(self, message: dict, room_id: str):
        # O odadaki herkese (gönderen dahil) mesajı ilet
        if room_id in self.active_connections:
            for connection in self.active_connections[room_id]:
                try:
                    await connection.send_json(message)
                except Exception as e:
                    # Bağlantı kopmuşsa hata vermemesi için pass geçiyoruz
                    # (İdealde burada disconnect çağrılabilir ama şimdilik basit tutalım)
                    print(f"Hata: Mesaj gönderilemedi. {e}")