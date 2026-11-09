ALTER TABLE rapport_stock_details
    ADD COLUMN IF NOT EXISTS perte numeric,
    ADD COLUMN IF NOT EXISTS ajustement numeric,
    ADD COLUMN IF NOT EXISTS justification_perte text,
    ADD COLUMN IF NOT EXISTS justification_ajustement text;

UPDATE rapport_stock_details
SET perte = GREATEST(-COALESCE(pertes_ajustements, 0), 0),
    ajustement = GREATEST(COALESCE(pertes_ajustements, 0), 0),
    justification_perte = CASE WHEN pertes_ajustements < 0 THEN commentaire END,
    justification_ajustement = CASE WHEN COALESCE(pertes_ajustements, 0) >= 0 THEN commentaire END
WHERE perte IS NULL AND ajustement IS NULL;

CREATE OR REPLACE FUNCTION rapport_stock_movements_compat() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.perte IS NULL AND NEW.ajustement IS NULL THEN
        NEW.perte := GREATEST(-COALESCE(NEW.pertes_ajustements, 0), 0);
        NEW.ajustement := GREATEST(COALESCE(NEW.pertes_ajustements, 0), 0);
        IF NEW.perte > 0 THEN
            NEW.justification_perte := NEW.commentaire;
        ELSE
            NEW.justification_ajustement := NEW.commentaire;
        END IF;
    ELSIF TG_OP = 'UPDATE' THEN
        IF NEW.perte IS NOT DISTINCT FROM OLD.perte
           AND NEW.ajustement IS NOT DISTINCT FROM OLD.ajustement
           AND NEW.pertes_ajustements IS DISTINCT FROM OLD.pertes_ajustements THEN
            NEW.perte := GREATEST(NEW.perte, -COALESCE(NEW.pertes_ajustements, 0), 0);
            NEW.ajustement := COALESCE(NEW.pertes_ajustements, 0) + NEW.perte;
        END IF;
        IF NEW.justification_ajustement IS NOT DISTINCT FROM OLD.justification_ajustement
           AND NEW.justification_perte IS NOT DISTINCT FROM OLD.justification_perte
           AND NEW.commentaire IS DISTINCT FROM OLD.commentaire THEN
            IF NEW.ajustement = 0 AND NEW.perte > 0 THEN
                NEW.justification_perte := NEW.commentaire;
            ELSE
                NEW.justification_ajustement := NEW.commentaire;
            END IF;
        END IF;
    END IF;
    NEW.perte := COALESCE(NEW.perte, 0);
    NEW.ajustement := COALESCE(NEW.ajustement, 0);
    IF NEW.perte < 0 OR NEW.ajustement < 0 THEN
        RAISE EXCEPTION 'Perte et ajustement doivent être positifs ou nuls' USING ERRCODE = '23514';
    END IF;
    NEW.pertes_ajustements := NEW.ajustement - NEW.perte;
    NEW.commentaire := COALESCE(NEW.justification_ajustement, NEW.justification_perte);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS rapport_stock_movements_compat ON rapport_stock_details;
CREATE TRIGGER rapport_stock_movements_compat
BEFORE INSERT OR UPDATE ON rapport_stock_details
FOR EACH ROW EXECUTE FUNCTION rapport_stock_movements_compat();
