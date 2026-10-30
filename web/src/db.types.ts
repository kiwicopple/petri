export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      cells: {
        Row: {
          created_at: string
          id: number
          mass: number
          merge_after: string
          player_id: string
          room_id: string
          synced_at: string
          x: number
          y: number
        }
        Insert: {
          created_at?: string
          id?: never
          mass: number
          merge_after?: string
          player_id: string
          room_id: string
          synced_at?: string
          x: number
          y: number
        }
        Update: {
          created_at?: string
          id?: never
          mass?: number
          merge_after?: string
          player_id?: string
          room_id?: string
          synced_at?: string
          x?: number
          y?: number
        }
        Relationships: [
          {
            foreignKeyName: "cells_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cells_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "room_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cells_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      pellets: {
        Row: {
          created_at: string
          id: number
          kind: string
          mass: number
          room_id: string
          x: number
          y: number
        }
        Insert: {
          created_at?: string
          id?: never
          kind?: string
          mass?: number
          room_id: string
          x: number
          y: number
        }
        Update: {
          created_at?: string
          id?: never
          kind?: string
          mass?: number
          room_id?: string
          x?: number
          y?: number
        }
        Relationships: [
          {
            foreignKeyName: "pellets_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "room_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pellets_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      players: {
        Row: {
          color: string
          ended_at: string | null
          id: string
          killed_by: string | null
          kills: number
          last_sync_at: string
          name: string
          peak_mass: number
          room_id: string
          skin: string | null
          spawned_at: string
          status: string
          user_id: string
        }
        Insert: {
          color: string
          ended_at?: string | null
          id?: string
          killed_by?: string | null
          kills?: number
          last_sync_at?: string
          name: string
          peak_mass?: number
          room_id: string
          skin?: string | null
          spawned_at?: string
          status?: string
          user_id: string
        }
        Update: {
          color?: string
          ended_at?: string | null
          id?: string
          killed_by?: string | null
          kills?: number
          last_sync_at?: string
          name?: string
          peak_mass?: number
          room_id?: string
          skin?: string | null
          spawned_at?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "players_killed_by_fkey"
            columns: ["killed_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "players_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "room_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "players_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      rooms: {
        Row: {
          blooms: Json
          created_at: string | null
          id: string
          max_players: number
          name: string
          pellet_target: number
          world_size: number
        }
        Insert: {
          blooms?: Json
          created_at?: string | null
          id?: string
          max_players?: number
          name: string
          pellet_target?: number
          world_size?: number
        }
        Update: {
          blooms?: Json
          created_at?: string | null
          id?: string
          max_players?: number
          name?: string
          pellet_target?: number
          world_size?: number
        }
        Relationships: []
      }
      scores: {
        Row: {
          created_at: string
          id: number
          kills: number
          name: string
          peak_mass: number
          player_id: string | null
          survived_seconds: number
          user_id: string | null
        }
        Insert: {
          created_at?: string
          id?: never
          kills: number
          name: string
          peak_mass: number
          player_id?: string | null
          survived_seconds: number
          user_id?: string | null
        }
        Update: {
          created_at?: string
          id?: never
          kills?: number
          name?: string
          peak_mass?: number
          player_id?: string | null
          survived_seconds?: number
          user_id?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      room_list: {
        Row: {
          id: string | null
          max_players: number | null
          name: string | null
          player_count: number | null
        }
        Insert: {
          id?: string | null
          max_players?: number | null
          name?: string | null
          player_count?: never
        }
        Update: {
          id?: string | null
          max_players?: number | null
          name?: string | null
          player_count?: never
        }
        Relationships: []
      }
      top_scores: {
        Row: {
          created_at: string | null
          kills: number | null
          name: string | null
          peak_mass: number | null
          survived_seconds: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      can_eat: {
        Args: { eater_mass: number; victim_mass: number }
        Returns: boolean
      }
      cell_radius: { Args: { m: number }; Returns: number }
      cell_speed: { Args: { m: number }; Returns: number }
      eat_cell: {
        Args: { p_eater: number; p_ex: number; p_ey: number; p_victim: number }
        Returns: Json
      }
      eat_overlap_ok: {
        Args: { dist: number; r_eater: number; r_victim: number }
        Returns: boolean
      }
      eject: {
        Args: { p_dx: number; p_dy: number; p_player: string }
        Returns: Json
      }
      game_tick: { Args: never; Returns: undefined }
      gc: { Args: never; Returns: Json }
      leave_game: { Args: { p_player: string }; Returns: undefined }
      merge_cells: { Args: { p_a: number; p_b: number }; Returns: Json }
      merge_delay: { Args: { m: number }; Returns: number }
      player_sync: {
        Args: { p_cells: Json; p_eaten: number[]; p_player: string }
        Returns: Json
      }
      pos_tolerance: {
        Args: { cell_age_s: number; dt: number; mass: number }
        Returns: number
      }
      spawn_player: {
        Args: {
          p_name: string
          p_room: string
          p_skin?: string
          p_user: string
        }
        Returns: Json
      }
      split: {
        Args: { p_dx: number; p_dy: number; p_player: string }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

