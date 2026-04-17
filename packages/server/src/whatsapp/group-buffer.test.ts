import { describe, expect, it } from "vitest";
import { GroupBuffer } from "./group-buffer";

describe("GroupBuffer", () => {
  describe("append and drain", () => {
    it("appends messages and drains them in order", () => {
      const buf = new GroupBuffer();
      buf.append("group1@g.us", { senderName: "Alice", text: "hello", timestamp: 1 });
      buf.append("group1@g.us", { senderName: "Bob", text: "hi", timestamp: 2 });

      const messages = buf.drain("group1@g.us");
      expect(messages).toEqual([
        { senderName: "Alice", text: "hello", timestamp: 1 },
        { senderName: "Bob", text: "hi", timestamp: 2 },
      ]);
    });

    it("auto-registers new groups on first append", () => {
      const buf = new GroupBuffer();
      buf.append("new-group@g.us", { senderName: "Alice", text: "first", timestamp: 1 });
      expect(buf.drain("new-group@g.us")).toHaveLength(1);
    });

    it("isolates messages between different groups", () => {
      const buf = new GroupBuffer();
      buf.append("group1@g.us", { senderName: "Alice", text: "g1 msg", timestamp: 1 });
      buf.append("group2@g.us", { senderName: "Bob", text: "g2 msg", timestamp: 2 });

      const g1 = buf.drain("group1@g.us");
      const g2 = buf.drain("group2@g.us");
      expect(g1).toHaveLength(1);
      expect(g1[0].text).toBe("g1 msg");
      expect(g2).toHaveLength(1);
      expect(g2[0].text).toBe("g2 msg");
    });
  });

  describe("drain", () => {
    it("clears the buffer after draining", () => {
      const buf = new GroupBuffer();
      buf.append("group1@g.us", { senderName: "Alice", text: "hello", timestamp: 1 });

      buf.drain("group1@g.us");
      const second = buf.drain("group1@g.us");
      expect(second).toEqual([]);
    });

    it("returns empty array for unknown group", () => {
      const buf = new GroupBuffer();
      expect(buf.drain("unknown@g.us")).toEqual([]);
    });

    it("returns a copy, not a reference to internal buffer", () => {
      const buf = new GroupBuffer();
      buf.append("group1@g.us", { senderName: "Alice", text: "hello", timestamp: 1 });

      const drained = buf.drain("group1@g.us");
      drained.push({ senderName: "Rogue", text: "injected", timestamp: 99 });

      // Internal buffer should not be affected
      buf.append("group1@g.us", { senderName: "Bob", text: "next", timestamp: 2 });
      const next = buf.drain("group1@g.us");
      expect(next).toHaveLength(1);
      expect(next[0].senderName).toBe("Bob");
    });
  });

  describe("clear", () => {
    it("clears buffered messages for the target group", () => {
      const buf = new GroupBuffer();
      buf.append("group1@g.us", { senderName: "Alice", text: "hello", timestamp: 1 });

      buf.clear("group1@g.us");

      expect(buf.drain("group1@g.us")).toEqual([]);
    });

    it("does not affect other groups", () => {
      const buf = new GroupBuffer();
      buf.append("group1@g.us", { senderName: "Alice", text: "hello", timestamp: 1 });
      buf.append("group2@g.us", { senderName: "Bob", text: "hi", timestamp: 2 });

      buf.clear("group1@g.us");

      expect(buf.drain("group1@g.us")).toEqual([]);
      expect(buf.drain("group2@g.us")).toEqual([{ senderName: "Bob", text: "hi", timestamp: 2 }]);
    });
  });

  describe("eviction", () => {
    it("evicts oldest messages when exceeding max capacity", () => {
      const buf = new GroupBuffer(3);
      buf.append("group1@g.us", { senderName: "A", text: "msg1", timestamp: 1 });
      buf.append("group1@g.us", { senderName: "B", text: "msg2", timestamp: 2 });
      buf.append("group1@g.us", { senderName: "C", text: "msg3", timestamp: 3 });
      buf.append("group1@g.us", { senderName: "D", text: "msg4", timestamp: 4 });

      const messages = buf.drain("group1@g.us");
      expect(messages).toHaveLength(3);
      expect(messages[0].text).toBe("msg2");
      expect(messages[1].text).toBe("msg3");
      expect(messages[2].text).toBe("msg4");
    });

    it("uses default max of 50", () => {
      const buf = new GroupBuffer();
      for (let i = 0; i < 55; i++) {
        buf.append("group1@g.us", { senderName: "User", text: `msg${i}`, timestamp: i });
      }

      const messages = buf.drain("group1@g.us");
      expect(messages).toHaveLength(50);
      expect(messages[0].text).toBe("msg5");
      expect(messages[49].text).toBe("msg54");
    });

    it("eviction only affects the target group", () => {
      const buf = new GroupBuffer(2);
      buf.append("group1@g.us", { senderName: "A", text: "g1-1", timestamp: 1 });
      buf.append("group1@g.us", { senderName: "B", text: "g1-2", timestamp: 2 });
      buf.append("group1@g.us", { senderName: "C", text: "g1-3", timestamp: 3 });
      buf.append("group2@g.us", { senderName: "X", text: "g2-1", timestamp: 1 });

      expect(buf.drain("group1@g.us")).toHaveLength(2);
      expect(buf.drain("group2@g.us")).toHaveLength(1);
    });
  });
});
