export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      ai_advisor_events: {
        Row: {
          completion_tokens: number
          cost_usd: number
          created_at: string
          error: string | null
          id: string
          kind: string
          model: string
          ok: boolean
          prompt_tokens: number
          total_tokens: number
          user_id: string
        }
        Insert: {
          completion_tokens?: number
          cost_usd?: number
          created_at?: string
          error?: string | null
          id?: string
          kind?: string
          model?: string
          ok?: boolean
          prompt_tokens?: number
          total_tokens?: number
          user_id: string
        }
        Update: {
          completion_tokens?: number
          cost_usd?: number
          created_at?: string
          error?: string | null
          id?: string
          kind?: string
          model?: string
          ok?: boolean
          prompt_tokens?: number
          total_tokens?: number
          user_id?: string
        }
        Relationships: []
      }
      ai_advisor_usage: {
        Row: {
          completion_tokens: number
          cost_usd: number
          created_at: string
          day: string
          error_count: number
          id: string
          last_error: string | null
          prompt_tokens: number
          request_count: number
          total_tokens: number
          updated_at: string
          user_id: string
        }
        Insert: {
          completion_tokens?: number
          cost_usd?: number
          created_at?: string
          day?: string
          error_count?: number
          id?: string
          last_error?: string | null
          prompt_tokens?: number
          request_count?: number
          total_tokens?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          completion_tokens?: number
          cost_usd?: number
          created_at?: string
          day?: string
          error_count?: number
          id?: string
          last_error?: string | null
          prompt_tokens?: number
          request_count?: number
          total_tokens?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      ai_credit_purchases: {
        Row: {
          amount_total: number | null
          created_at: string
          credits: number
          currency: string | null
          environment: string
          id: string
          price_id: string
          stripe_session_id: string
          user_id: string
        }
        Insert: {
          amount_total?: number | null
          created_at?: string
          credits: number
          currency?: string | null
          environment?: string
          id?: string
          price_id: string
          stripe_session_id: string
          user_id: string
        }
        Update: {
          amount_total?: number | null
          created_at?: string
          credits?: number
          currency?: string | null
          environment?: string
          id?: string
          price_id?: string
          stripe_session_id?: string
          user_id?: string
        }
        Relationships: []
      }
      ai_credits: {
        Row: {
          balance: number
          created_at: string
          purchased_total: number
          updated_at: string
          used_total: number
          user_id: string
        }
        Insert: {
          balance?: number
          created_at?: string
          purchased_total?: number
          updated_at?: string
          used_total?: number
          user_id: string
        }
        Update: {
          balance?: number
          created_at?: string
          purchased_total?: number
          updated_at?: string
          used_total?: number
          user_id?: string
        }
        Relationships: []
      }
      ai_knowledge_docs: {
        Row: {
          category: string
          content: string
          created_at: string
          created_by: string | null
          id: string
          is_active: boolean
          modes: string[]
          reviewed_on: string | null
          source: string | null
          species: string[]
          tags: string[]
          title: string
          updated_at: string
        }
        Insert: {
          category?: string
          content: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          modes?: string[]
          reviewed_on?: string | null
          source?: string | null
          species?: string[]
          tags?: string[]
          title: string
          updated_at?: string
        }
        Update: {
          category?: string
          content?: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          modes?: string[]
          reviewed_on?: string | null
          source?: string | null
          species?: string[]
          tags?: string[]
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      catch_reports: {
        Row: {
          bait: string | null
          created_at: string
          depth_m: number | null
          env_snapshot: Json
          factors_snapshot: Json
          fished_at: string
          id: string
          lat: number
          lng: number
          mode: Database["public"]["Enums"]["fishing_mode"]
          note: string | null
          outcome: Database["public"]["Enums"]["catch_outcome"]
          quality: string | null
          quantity: number | null
          score_snapshot: number | null
          species: string | null
          technique: string | null
          updated_at: string
          user_id: string
          validated: boolean
        }
        Insert: {
          bait?: string | null
          created_at?: string
          depth_m?: number | null
          env_snapshot?: Json
          factors_snapshot?: Json
          fished_at?: string
          id?: string
          lat: number
          lng: number
          mode: Database["public"]["Enums"]["fishing_mode"]
          note?: string | null
          outcome: Database["public"]["Enums"]["catch_outcome"]
          quality?: string | null
          quantity?: number | null
          score_snapshot?: number | null
          species?: string | null
          technique?: string | null
          updated_at?: string
          user_id: string
          validated?: boolean
        }
        Update: {
          bait?: string | null
          created_at?: string
          depth_m?: number | null
          env_snapshot?: Json
          factors_snapshot?: Json
          fished_at?: string
          id?: string
          lat?: number
          lng?: number
          mode?: Database["public"]["Enums"]["fishing_mode"]
          note?: string | null
          outcome?: Database["public"]["Enums"]["catch_outcome"]
          quality?: string | null
          quantity?: number | null
          score_snapshot?: number | null
          species?: string | null
          technique?: string | null
          updated_at?: string
          user_id?: string
          validated?: boolean
        }
        Relationships: []
      }
      fsle_exports: {
        Row: {
          content: string
          created_at: string
          filename: string
          line_count: number
          token: string
        }
        Insert: {
          content: string
          created_at?: string
          filename: string
          line_count?: number
          token: string
        }
        Update: {
          content?: string
          created_at?: string
          filename?: string
          line_count?: number
          token?: string
        }
        Relationships: []
      }
      invite_codes: {
        Row: {
          code: string
          created_at: string
          created_by: string | null
          days: number
          expires_at: string | null
          max_uses: number
          modules: string[]
          note: string | null
          uses: number
        }
        Insert: {
          code: string
          created_at?: string
          created_by?: string | null
          days?: number
          expires_at?: string | null
          max_uses?: number
          modules?: string[]
          note?: string | null
          uses?: number
        }
        Update: {
          code?: string
          created_at?: string
          created_by?: string | null
          days?: number
          expires_at?: string | null
          max_uses?: number
          modules?: string[]
          note?: string | null
          uses?: number
        }
        Relationships: []
      }
      invite_grants: {
        Row: {
          code: string
          created_at: string
          expires_at: string
          id: string
          modules: string[]
          user_id: string
        }
        Insert: {
          code: string
          created_at?: string
          expires_at: string
          id?: string
          modules: string[]
          user_id: string
        }
        Update: {
          code?: string
          created_at?: string
          expires_at?: string
          id?: string
          modules?: string[]
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          boat_name: string | null
          created_at: string
          full_name: string | null
          id: string
          port: string | null
          updated_at: string
        }
        Insert: {
          boat_name?: string | null
          created_at?: string
          full_name?: string | null
          id: string
          port?: string | null
          updated_at?: string
        }
        Update: {
          boat_name?: string | null
          created_at?: string
          full_name?: string | null
          id?: string
          port?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      sounding_sessions: {
        Row: {
          created_at: string
          east: number | null
          ended_at: string | null
          id: string
          is_shared: boolean
          max_depth_m: number | null
          min_depth_m: number | null
          name: string
          north: number | null
          point_count: number
          points: Json
          source: string
          south: number | null
          spacing_m: number | null
          started_at: string
          updated_at: string
          user_id: string
          west: number | null
        }
        Insert: {
          created_at?: string
          east?: number | null
          ended_at?: string | null
          id?: string
          is_shared?: boolean
          max_depth_m?: number | null
          min_depth_m?: number | null
          name?: string
          north?: number | null
          point_count?: number
          points?: Json
          source?: string
          south?: number | null
          spacing_m?: number | null
          started_at?: string
          updated_at?: string
          user_id: string
          west?: number | null
        }
        Update: {
          created_at?: string
          east?: number | null
          ended_at?: string | null
          id?: string
          is_shared?: boolean
          max_depth_m?: number | null
          min_depth_m?: number | null
          name?: string
          north?: number | null
          point_count?: number
          points?: Json
          source?: string
          south?: number | null
          spacing_m?: number | null
          started_at?: string
          updated_at?: string
          user_id?: string
          west?: number | null
        }
        Relationships: []
      }
      subscriptions: {
        Row: {
          cancel_at_period_end: boolean | null
          created_at: string | null
          current_period_end: string | null
          current_period_start: string | null
          environment: string
          id: string
          price_id: string
          product_id: string
          status: string
          stripe_customer_id: string
          stripe_subscription_id: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          cancel_at_period_end?: boolean | null
          created_at?: string | null
          current_period_end?: string | null
          current_period_start?: string | null
          environment?: string
          id?: string
          price_id: string
          product_id: string
          status?: string
          stripe_customer_id: string
          stripe_subscription_id: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          cancel_at_period_end?: boolean | null
          created_at?: string | null
          current_period_end?: string | null
          current_period_start?: string | null
          environment?: string
          id?: string
          price_id?: string
          product_id?: string
          status?: string
          stripe_customer_id?: string
          stripe_subscription_id?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      user_weights: {
        Row: {
          created_at: string
          id: string
          mode: Database["public"]["Enums"]["fishing_mode"]
          n_samples: number
          updated_at: string
          user_id: string
          weights: Json
        }
        Insert: {
          created_at?: string
          id?: string
          mode: Database["public"]["Enums"]["fishing_mode"]
          n_samples?: number
          updated_at?: string
          user_id: string
          weights?: Json
        }
        Update: {
          created_at?: string
          id?: string
          mode?: Database["public"]["Enums"]["fishing_mode"]
          n_samples?: number
          updated_at?: string
          user_id?: string
          weights?: Json
        }
        Relationships: []
      }
      waitlist: {
        Row: {
          created_at: string
          email: string
          id: string
          source: string | null
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          source?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          source?: string | null
        }
        Relationships: []
      }
      waypoints: {
        Row: {
          created_at: string
          depth: number | null
          id: string
          lat: number
          lng: number
          name: string
          reason: string
          saved_at: string
          score: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          depth?: number | null
          id?: string
          lat: number
          lng: number
          name: string
          reason?: string
          saved_at?: string
          score?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          depth?: number | null
          id?: string
          lat?: number
          lng?: number
          name?: string
          reason?: string
          saved_at?: string
          score?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      consume_ai_credit: { Args: { _user_id: string }; Returns: number }
      grant_ai_credits: {
        Args: {
          _amount_total: number
          _credits: number
          _currency: string
          _environment: string
          _price_id: string
          _session_id: string
          _user_id: string
        }
        Returns: boolean
      }
      has_module_access: {
        Args: { check_env?: string; module_price_id: string; user_uuid: string }
        Returns: boolean
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "moderator" | "user"
      catch_outcome: "good" | "bad"
      fishing_mode: "bottom" | "squid" | "surface" | "drift"
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
  public: {
    Enums: {
      app_role: ["admin", "moderator", "user"],
      catch_outcome: ["good", "bad"],
      fishing_mode: ["bottom", "squid", "surface", "drift"],
    },
  },
} as const

